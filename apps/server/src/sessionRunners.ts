import type {
  AgentPrincipal,
  CoreModelBackend,
  HostToolResolver,
} from "@agentlink/core";
import type {
  WorkspaceApprovalHostTools,
  WorkspaceBackgroundChange,
} from "@agentlink/workspace-host";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  approvalToolProxyRoutes,
  createRunnerApprovalGrants,
  hostToolProxyRoutes,
  type RunnerApprovalCard,
  type RunnerApprovalGrants,
} from "./remoteHostTools.js";
import { modelProxyRoutes } from "./remoteModels.js";
import { writeFileAtomic } from "./atomicFile.js";
import {
  createRemoteWorkspaceHost,
  type RemoteSessionCache,
  type RemoteWorkspaceHost,
} from "./remoteWorkspaceHost.js";
import type { RunnerManagerClient } from "./runnerManager.js";
import {
  createRunnerHttpClient,
  sameToken,
  startRunnerHttpServer,
  type RunnerHttpServer,
  type RunnerRouteHandler,
} from "./runnerProtocol.js";
import type { SessionApprovalMode } from "./SessionApprovalModes.js";
import { RUNNER_ENV, type SessionRunnerSpec } from "./sessionRunner.js";

/**
 * The card the owner answered for a session: its pending interaction, but
 * only if it is the exact interaction (and revision) the decision names.
 * Undefined approves nothing.
 */
async function pendingCard(
  host: Pick<RemoteWorkspaceHost, "readSession">,
  sessionId: string,
  expected:
    | { readonly interactionId: string; readonly interactionRevision: string }
    | undefined,
): Promise<RunnerApprovalCard | undefined> {
  if (!expected) return undefined;
  const pending = await host
    .readSession(sessionId)
    .then((snapshot) => snapshot.pendingInteraction)
    .catch(() => undefined);
  if (
    !pending ||
    pending.request.interactionId !== expected.interactionId ||
    pending.interactionRevision !== expected.interactionRevision
  ) {
    return undefined;
  }
  return {
    toolName: pending.request.toolName,
    summary: pending.request.summary,
    ...(pending.request.displayContent === undefined
      ? {}
      : { displayContent: pending.request.displayContent }),
  };
}

/** The background child's card the owner answered, by its interaction. */
async function backgroundCard(
  host: Pick<RemoteWorkspaceHost, "listBackgroundAgents">,
  request: {
    readonly callerSessionId: string;
    readonly childSessionId: string;
    readonly interactionId: string;
  },
): Promise<RunnerApprovalCard | undefined> {
  const agents = await Promise.resolve(
    host.listBackgroundAgents(request.callerSessionId),
  ).catch(() => []);
  const approval = agents.find(
    (agent) => agent.childSessionId === request.childSessionId,
  )?.approval;
  if (!approval || approval.interactionId !== request.interactionId) {
    return undefined;
  }
  return {
    toolName: approval.toolName,
    summary: approval.summary,
    ...(approval.displayContent === undefined
      ? {}
      : { displayContent: approval.displayContent }),
  };
}

/**
 * The control plane's side of session runners: one runner per coding task
 * session, started through the runner manager on first use, with a fresh
 * token each time it starts. The same server answers every runner's model
 * calls and host tool calls, telling runners apart by their token, so a
 * runner can only use its own project's tools.
 */

export interface SessionRunnerPoolOptions {
  readonly manager: Pick<RunnerManagerClient, "start" | "stop" | "stopAll">;
  /** The control plane's model backends (they hold the sign-ins). */
  readonly backends: readonly CoreModelBackend[];
  /** Read-only host tools for a runner's project (web tools). */
  readonly hostTools: (projectId: string) => HostToolResolver;
  /**
   * Host tools that need approval (MCP calls), run on the control plane
   * only after the owner's decision passes through it.
   */
  readonly approvalHostTools?: (
    projectId: string,
  ) => WorkspaceApprovalHostTools | undefined;
  /** Where the proxy listens, and the URL runners reach it at. */
  readonly listen: { readonly host: string; readonly port: number };
  readonly controlUrl: string;
  /** Runners' data folders: `<dataRoot>/<projectId>`. */
  readonly dataRoot: string;
  /**
   * The control plane's copies of runners' session lists and transcripts
   * (`<cacheRoot>/<projectId>`), so finished tasks' chats can be shown
   * without starting their runners. Outside the runners' data folders, so
   * no runner can write them.
   */
  readonly cacheRoot?: string;
  readonly approvalMode: (
    projectId: string,
    sessionId: string,
  ) => SessionApprovalMode;
  readonly onAgentApproval?: (request: {
    readonly projectId: string;
    readonly parentSessionId: string;
    readonly childSessionId: string;
  }) => void;
  readonly onAgentChanged?: (
    change: WorkspaceBackgroundChange & { readonly projectId: string },
  ) => void;
  readonly onTurnFailure?: (
    projectId: string,
    sessionId: string,
    detail: string,
  ) => void;
  readonly idleMs?: number;
  /** How long a starting runner may take to answer. */
  readonly startTimeoutMs?: number;
  readonly log: (line: string) => void;
}

export interface SessionRunnerPool {
  /** The proxy's port (useful when listening on port 0). */
  readonly port: number;
  /** A host for this project whose sessions run in a runner. */
  open(spec: SessionRunnerSpec, folder: string): RemoteWorkspaceHost;
  close(): Promise<void>;
}

const DEFAULT_START_TIMEOUT_MS = 60_000;

export async function startSessionRunnerPool(
  options: SessionRunnerPoolOptions,
): Promise<SessionRunnerPool> {
  /** Current token → the runner's project. */
  const tokens = new Map<string, string>();
  const routesByProject = new Map<string, Record<string, RunnerRouteHandler>>();
  const grantsByProject = new Map<string, RunnerApprovalGrants>();
  const grantsFor = (projectId: string) => {
    let grants = grantsByProject.get(projectId);
    if (!grants) {
      grants = createRunnerApprovalGrants();
      grantsByProject.set(projectId, grants);
    }
    return grants;
  };
  const routesFor = (projectId: string) => {
    let routes = routesByProject.get(projectId);
    if (!routes) {
      const principal: AgentPrincipal = {
        tenantId: "local",
        subjectId: `runner:${projectId}`,
      };
      const approvalTools = options.approvalHostTools?.(projectId);
      routes = {
        ...modelProxyRoutes({ backends: options.backends, principal }),
        ...hostToolProxyRoutes({
          resolve: options.hostTools(projectId),
          principal,
        }),
        ...(approvalTools
          ? approvalToolProxyRoutes({
              tools: approvalTools,
              principal,
              grants: grantsFor(projectId),
            })
          : { "/approval-tools/names": async () => [] }),
      };
      routesByProject.set(projectId, routes);
    }
    return routes;
  };
  // Previous runs' runners: their tokens are gone with that process.
  await options.manager.stopAll().catch((error: unknown) => {
    options.log(`Could not clear old runners: ${describe(error)}`);
  });
  const server: RunnerHttpServer = await startRunnerHttpServer({
    host: options.listen.host,
    port: options.listen.port,
    authorize: (presented) => {
      for (const [token, projectId] of tokens) {
        if (sameToken(token, presented)) return projectId;
      }
      return undefined;
    },
    routes: (projectId) => routesFor(projectId),
    log: options.log,
  });
  const hosts = new Set<RemoteWorkspaceHost>();
  return {
    port: server.port,
    open(spec, folder) {
      const projectId = spec.projectId;
      let token = "";
      let url = "";
      const client = createRunnerHttpClient({
        baseUrl: () => url,
        token: () => token,
      });
      const forget = () => {
        if (token) tokens.delete(token);
      };
      const dataFolder = path.join(options.dataRoot, projectId);
      const host = createRemoteWorkspaceHost({
        client,
        async start() {
          forget();
          token = randomBytes(32).toString("hex");
          tokens.set(token, projectId);
          await fs.mkdir(dataFolder, { recursive: true, mode: 0o700 });
          const started = await options.manager.start({
            id: projectId,
            folder,
            dataFolder,
            env: {
              [RUNNER_ENV.token]: token,
              [RUNNER_ENV.controlUrl]: options.controlUrl,
              [RUNNER_ENV.spec]: JSON.stringify(spec),
            },
          });
          url = started.url;
          const deadline =
            Date.now() + (options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
          for (;;) {
            try {
              await client.health(AbortSignal.timeout(5_000));
              break;
            } catch (error) {
              if (Date.now() > deadline) {
                throw Object.assign(
                  new Error(
                    `The runner for ${projectId} did not start: ${describe(error)}`,
                  ),
                  { code: "runner_start_failed" },
                );
              }
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          }
          options.log(`Runner for ${projectId} is up`);
        },
        async stop() {
          forget();
          token = "";
          await options.manager.stop(projectId);
          options.log(`Stopped the runner for ${projectId}`);
        },
        approvalMode: (sessionId) => options.approvalMode(projectId, sessionId),
        onAgentApproval: (request) =>
          options.onAgentApproval?.({ ...request, projectId }),
        onAgentChanged: (change) =>
          options.onAgentChanged?.({ ...change, projectId }),
        onTurnFailure: (sessionId, detail) =>
          options.onTurnFailure?.(projectId, sessionId, detail),
        ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
        ...(options.cacheRoot
          ? { cache: fileSessionCache(path.join(options.cacheRoot, projectId)) }
          : {}),
        log: options.log,
      });
      const closeHost = host.close;
      const grants = grantsFor(projectId);
      const tracked: RemoteWorkspaceHost = {
        ...host,
        // The owner's decisions pass through here, so a runner can run an
        // approval tool only after the owner allowed it, and only the call
        // prepared for the exact card the owner answered.
        resumeInteraction: async (sessionId, decision, resumeOptions) => {
          grants.decide(
            sessionId,
            decision,
            decision === "allow"
              ? await pendingCard(host, sessionId, resumeOptions?.expected)
              : undefined,
          );
          return await host.resumeInteraction(
            sessionId,
            decision,
            resumeOptions,
          );
        },
        respondToBackgroundApproval: async (request) => {
          grants.decide(
            request.childSessionId,
            request.decision,
            request.decision === "allow"
              ? await backgroundCard(host, request)
              : undefined,
          );
          return await host.respondToBackgroundApproval(request);
        },
        async close() {
          hosts.delete(tracked);
          await closeHost();
        },
      };
      hosts.add(tracked);
      return tracked;
    },
    async close() {
      // Each close removes its host; deleting the current entry is safe.
      for (const host of hosts) {
        await host.close().catch((error: unknown) => {
          options.log(`Could not stop a runner: ${describe(error)}`);
        });
      }
      tokens.clear();
      await server.close();
    },
  };
}

const CACHE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,160}$/u;

/** One JSON file per key, written atomically. */
export function fileSessionCache(directory: string): RemoteSessionCache {
  const file = (key: string) => {
    if (!CACHE_KEY_PATTERN.test(key)) throw new Error("cache_key_invalid");
    return path.join(directory, `${key}.json`);
  };
  return {
    async read(key) {
      try {
        return JSON.parse(await fs.readFile(file(key), "utf8")) as unknown;
      } catch {
        return undefined;
      }
    },
    async write(key, value) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFileAtomic(file(key), JSON.stringify(value));
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
