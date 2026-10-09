import {
  createWorkspaceHost,
  type WorkspaceHost,
} from "@agentlink/workspace-host";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createSecureContext } from "node:tls";

import {
  createAssistantServer,
  type AssistantServer,
} from "./assistantServer.js";
import {
  resolveWorkspaceProviders,
  type AssistantServerConfig,
} from "./serverConfig.js";
import {
  createAssistantWorkspaceRoutes,
  ownerProjectAccess,
  type AuthorizeAssistantProject,
} from "./workspaceRoutes.js";

export interface AssistantServiceOptions {
  readonly config: AssistantServerConfig;
  /** Operator log: the local console, journald, or the launchd log file. */
  readonly log: (line: string) => void;
  /** Environment used to resolve systemd credentials. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface AssistantService {
  readonly server: AssistantServer;
  readonly port: number;
  /** Stops turns, closes connections, releases the data-root lock and hosts. */
  close(): Promise<void>;
}

/** Where the access store (owner, devices, sessions) lives under the data root. */
export function serverAccessDataRoot(config: AssistantServerConfig): string {
  return path.join(config.dataRoot, "server");
}

export interface AssistantServicePreflight {
  readonly tls: { readonly cert: Buffer; readonly key: Buffer };
}

/**
 * Check everything that can be checked without taking locks or listening:
 * TLS material and permissions, project directories, and provider secrets.
 */
export async function preflightAssistantService(
  config: AssistantServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AssistantServicePreflight> {
  const cert = await readRequired(config.tls.certFile, "tls.certFile");
  const keyStat = await fs.stat(config.tls.keyFile).catch((error: unknown) => {
    throw new Error(`Cannot read tls.keyFile: ${message(error)}`);
  });
  // Group read is allowed for the Debian `ssl-cert` convention (0640).
  if ((keyStat.mode & 0o007) !== 0) {
    throw new Error(
      `tls.keyFile (${config.tls.keyFile}) must not be accessible by others (chmod 600 or 640)`,
    );
  }
  const key = await readRequired(config.tls.keyFile, "tls.keyFile");
  try {
    createSecureContext({ cert, key, minVersion: "TLSv1.2" });
  } catch (error) {
    throw new Error(`TLS certificate or key is unusable: ${message(error)}`);
  }
  for (const project of config.projects) {
    const stat = await fs.stat(project.root).catch(() => undefined);
    if (!stat?.isDirectory()) {
      throw new Error(
        `Project "${project.id}" root is not a directory: ${project.root}`,
      );
    }
  }
  if (config.ripgrepPath) {
    await fs.access(config.ripgrepPath, fs.constants.X_OK).catch(() => {
      throw new Error(`ripgrepPath is not executable: ${config.ripgrepPath}`);
    });
  }
  await resolveWorkspaceProviders(config.providers, env);
  return { tls: { cert, key } };
}

export async function startAssistantService(
  options: AssistantServiceOptions,
): Promise<AssistantService> {
  const { config, log } = options;
  const env = options.env ?? process.env;
  const { tls } = await preflightAssistantService(config, env);
  await fs.mkdir(config.dataRoot, { recursive: true, mode: 0o700 });
  const providers = await resolveWorkspaceProviders(config.providers, env);
  const ownerId = `agentlink-server-${process.pid}-${randomUUID()}`;

  const hosts: Array<{ readonly id: string; readonly host: WorkspaceHost }> =
    [];
  const closeHosts = async () => {
    for (const { id, host } of hosts.splice(0).reverse()) {
      await host.close().catch((error: unknown) => {
        log(`Failed to close project "${id}": ${message(error)}`);
      });
    }
  };

  const recovery = createSessionRecovery(log);
  let server: AssistantServer | undefined;
  try {
    for (const project of config.projects) {
      const host = await createWorkspaceHost({
        projectRoot: project.root,
        dataRoot: path.join(config.dataRoot, "workspace"),
        ownerId,
        providers,
        defaultModel: config.defaultModel,
        promptIdentity: { role: "a personal assistant" },
        files: {
          enabled: true,
          ...(config.ripgrepPath
            ? { ripgrepExecutable: config.ripgrepPath }
            : {}),
        },
      });
      hosts.push({ id: project.id, host });
      await recovery.recoverProject(project.id, host);
    }

    // Routes are created first so the server can stop them on close; the
    // owner mapping needs the store, which exists once the server does.
    let authorizeProject: AuthorizeAssistantProject = () => false;
    const routes = createAssistantWorkspaceRoutes({
      projects: hosts.map(({ id, host }) => ({
        projectId: id,
        label: config.projects.find((project) => project.id === id)?.label,
        host,
      })),
      authorizeProject: (request) => authorizeProject(request),
    });
    server = await createAssistantServer({
      dataRoot: serverAccessDataRoot(config),
      tls,
      publicOrigins: config.publicOrigins,
      listen: config.listen,
      handleRequest: routes.handleRequest,
      onClose: () => routes.close(),
      onSetupCredential: ({ token, expiresAt }) => {
        log(
          [
            "No owner is configured yet.",
            `Setup credential (single use, expires ${new Date(expiresAt).toISOString()}):`,
            `  ${token}`,
            `Open ${config.publicOrigins[0]} and enter it to create the owner.`,
          ].join("\n"),
        );
      },
    });
    authorizeProject = ownerProjectAccess(server.store);
    const { port } = await server.start();
    log(
      `AgentLink server listening on ${config.listen.host}:${port} for ${config.publicOrigins.join(", ")} (${hosts.length} project${hosts.length === 1 ? "" : "s"})`,
    );
    const started = server;
    let closing: Promise<void> | undefined;
    return {
      server: started,
      port,
      close() {
        closing ??= (async () => {
          recovery.stop();
          await started.close();
          await recovery.settled();
          await closeHosts();
        })();
        return closing;
      },
    };
  } catch (error) {
    recovery.stop();
    await server?.close().catch(() => undefined);
    await recovery.settled();
    await closeHosts();
    throw error;
  }
}

const RECOVERY_RETRY_MS = 2_000;
const RECOVERY_MAX_ATTEMPTS = 60;

/**
 * A turn that was running when the previous process stopped cannot still be
 * running now. Mark it interrupted so the session accepts new turns.
 *
 * After a crash the dead process's turn lease stays valid until it expires
 * (30 seconds by default). The lease is never broken early: recovery retries
 * in the background, the session reports busy meanwhile, and the server
 * starts regardless. One unreadable session never blocks startup.
 */
function createSessionRecovery(log: (line: string) => void) {
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pending = new Set<Promise<void>>();

  const attempt = (
    projectId: string,
    host: WorkspaceHost,
    sessionId: string,
    attemptNumber: number,
  ): Promise<void> => {
    const run = (async () => {
      if (stopped) return;
      try {
        await host.recoverInterrupted(sessionId);
        log(
          `Recovered interrupted session ${sessionId} in project "${projectId}"`,
        );
      } catch (error) {
        if (stopped) return;
        if (
          errorCode(error) === "turn_lease_held" &&
          attemptNumber < RECOVERY_MAX_ATTEMPTS
        ) {
          if (attemptNumber === 1) {
            log(
              `Session ${sessionId} in project "${projectId}" is still leased by the previous process; recovering when the lease expires`,
            );
          }
          const timer = setTimeout(() => {
            timers.delete(timer);
            void attempt(projectId, host, sessionId, attemptNumber + 1);
          }, RECOVERY_RETRY_MS);
          timers.add(timer);
          return;
        }
        log(
          `Could not recover session ${sessionId} in project "${projectId}": ${message(error)}`,
        );
      }
    })();
    pending.add(run);
    void run.finally(() => pending.delete(run));
    return run;
  };

  return {
    async recoverProject(projectId: string, host: WorkspaceHost) {
      for (const session of await host.listSessions()) {
        if (host.isBackgroundSession(session.sessionId)) continue;
        let phase: string;
        try {
          phase = (await host.readSession(session.sessionId)).record.runState
            .phase;
        } catch (error) {
          log(
            `Skipping unreadable session ${session.sessionId} in project "${projectId}": ${message(error)}`,
          );
          continue;
        }
        if (phase === "running" || phase === "resuming") {
          await attempt(projectId, host, session.sessionId, 1);
        }
      }
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
    async settled() {
      await Promise.all(pending);
    },
  };
}

function errorCode(error: unknown): string | undefined {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" ? code : undefined;
}

async function readRequired(file: string, label: string): Promise<Buffer> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    throw new Error(`Cannot read ${label} (${file}): ${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
