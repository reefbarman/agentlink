import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  ASSISTANT_TERMINAL_UPDATE_PHASES,
  assistantUpdateIsActive,
  type AssistantUpdateDiscovery,
  type AssistantUpdateOperation,
  type AssistantUpdatePhase,
  type AssistantUpdateStatus,
} from "../../../src/shared/assistantUpdates.js";

import type { GithubReleaseClient } from "../../../src/updates/githubReleaseClient.js";
import {
  compareReleaseVersions,
  parseReleaseVersion,
} from "../../../src/updates/releaseSelection.js";
import { writeFileAtomic } from "./atomicFile.js";
import { tokensMatch } from "./commandWorkerProtocol.js";
import { withFileLock } from "./fileLock.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";
import {
  validateUpdateBody,
  type UpdateConfirmation,
  type UpdatePreferences,
} from "./updaterClient.js";
import {
  readInstalledDeploymentState,
  runDeploymentUpdate,
  runDeploymentRollback,
} from "./updateDeployment.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PHASES: readonly AssistantUpdatePhase[] = [
  "queued",
  "downloading",
  "validating",
  "pulling",
  "draining",
  "backing_up",
  "installing",
  "checking_health",
  "rolling_back",
  "reconnecting",
  ...ASSISTANT_TERMINAL_UPDATE_PHASES,
];
const LABEL = "io.agentlink.updater.operation";

export interface InstalledDeploymentState {
  managed: boolean;
  version: string | null;
  commit: string | null;
  rollbackVersion: string | null;
}
export interface UpdaterJobLauncher {
  launch(operation: AssistantUpdateOperation): Promise<void>;
  inspect(operationId: string): Promise<"running" | "stopped" | "missing">;
}
export interface AssistantReleaseDiscoveryService {
  start(): Promise<void>;
  snapshot(): AssistantUpdateDiscovery;
  check(manual?: boolean): Promise<AssistantUpdateDiscovery>;
  setPreferences(value: UpdatePreferences): Promise<void>;
  dispose(): void;
}
export interface AssistantUpdaterOptions {
  host?: string;
  port?: number;
  token: string;
  deployDirectory: string;
  updaterDirectory: string;
  jobImage?: string;
  dockerSocket?: string;
  now?: () => number;
  jobs?: UpdaterJobLauncher;
  releases?: AssistantReleaseDiscoveryService;
  releaseClient?: Pick<GithubReleaseClient, "discover">;
  readInstalled?: (options: {
    deployDirectory: string;
  }) => Promise<InstalledDeploymentState>;
  /** Disable the reconciliation timer in tests; GET still reconciles. */
  schedule?: boolean;
}
export interface AssistantUpdater {
  address: AddressInfo;
  close(): Promise<void>;
}

function validateRoots(
  deployDirectory: string,
  updaterDirectory: string,
): void {
  for (const root of [deployDirectory, updaterDirectory]) {
    if (
      !path.isAbsolute(root) ||
      path.normalize(root) !== root ||
      root === "/" ||
      root.includes("\0") ||
      /[\r\n:]/u.test(root)
    )
      throw new Error("update_root_invalid");
  }
  if (
    deployDirectory === updaterDirectory ||
    updaterDirectory.startsWith(`${deployDirectory}/`) ||
    deployDirectory.startsWith(`${updaterDirectory}/`)
  )
    throw new Error("update_roots_overlap");
}
function operationFile(root: string, id: string): string {
  if (!UUID.test(id)) throw new Error("update_operation_invalid");
  return path.join(root, "operations", `${id}.json`);
}
async function boundedJson(file: string, max = 4096): Promise<unknown> {
  const handle = await fs.open(file, "r");
  try {
    if ((await handle.stat()).size > max)
      throw new Error("update_state_invalid");
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}
function parseOperation(value: unknown): AssistantUpdateOperation {
  if (!value || typeof value !== "object")
    throw new Error("update_state_invalid");
  const op = value as AssistantUpdateOperation;
  if (
    !UUID.test(op.id) ||
    !["update", "rollback"].includes(op.kind) ||
    typeof op.fromVersion !== "string" ||
    !parseReleaseVersion(op.fromVersion) ||
    typeof op.targetVersion !== "string" ||
    !parseReleaseVersion(op.targetVersion) ||
    !PHASES.includes(op.phase) ||
    !Number.isFinite(op.startedAt) ||
    !Number.isFinite(op.updatedAt) ||
    (op.completedAt !== undefined && !Number.isFinite(op.completedAt))
  )
    throw new Error("update_state_invalid");
  return {
    id: op.id,
    kind: op.kind,
    fromVersion: op.fromVersion,
    targetVersion: op.targetVersion,
    phase: op.phase,
    startedAt: op.startedAt,
    updatedAt: op.updatedAt,
    ...(op.completedAt === undefined ? {} : { completedAt: op.completedAt }),
    ...(op.error === undefined
      ? {}
      : {
          error:
            op.phase === "interrupted"
              ? "update_interrupted"
              : "update_job_failed",
        }),
  };
}
async function readOperation(
  root: string,
  id: string,
): Promise<AssistantUpdateOperation> {
  const op = parseOperation(await boundedJson(operationFile(root, id)));
  if (op.id !== id) throw new Error("update_state_invalid");
  return op;
}
async function currentOperation(
  root: string,
): Promise<AssistantUpdateOperation | null> {
  let pointer: unknown;
  try {
    pointer = await boundedJson(path.join(root, "current-operation.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const id = (pointer as { id?: unknown })?.id;
  if (typeof id !== "string") throw new Error("update_state_invalid");
  return readOperation(root, id);
}
async function saveOperation(
  root: string,
  operation: AssistantUpdateOperation,
): Promise<void> {
  await writeFileAtomic(
    operationFile(root, operation.id),
    `${JSON.stringify(operation)}\n`,
  );
}
function locked<T>(root: string, action: () => Promise<T>): Promise<T> {
  // A newly started worker may arrive before both bounded Docker launch calls finish.
  return withFileLock(path.join(root, "operation.lock"), action, {
    timeoutMs: 45_000,
  });
}

/** Private bearer-authenticated sidecar. No path, image, command or URL is request-controlled. */
export async function startAssistantUpdater(
  options: AssistantUpdaterOptions,
): Promise<AssistantUpdater> {
  validateRoots(options.deployDirectory, options.updaterDirectory);
  if (!options.token.trim() || /[\r\n]/.test(options.token))
    throw new Error("update_token_invalid");
  await fs.mkdir(path.join(options.updaterDirectory, "operations"), {
    recursive: true,
    mode: 0o700,
  });
  const now = options.now ?? Date.now;
  const installed = () =>
    (options.readInstalled ?? readInstalledDeploymentState)({
      deployDirectory: options.deployDirectory,
    });
  const initial = await installed();
  // Released installations must run the trusted, immutable updater image selected
  // by their standalone Compose configuration, never a mutable development tag.
  function requirePinnedJobImage(): void {
    if (
      !options.jobs &&
      !/^ghcr\.io\/reefbarman\/agentlink-updater@sha256:[0-9a-f]{64}$/.test(
        options.jobImage ?? "",
      )
    )
      throw new Error("update_image_unpinned");
  }
  if (initial.managed) requirePinnedJobImage();
  const { AssistantReleaseUpdateService } =
    await import("../../../src/updates/assistantReleaseUpdateService.js");
  const createReleases = (version: string) =>
    new AssistantReleaseUpdateService({
      version,
      target: process.arch === "arm64" ? "linux-arm64" : "linux-x64",
      storageDirectory: path.join(options.updaterDirectory, "releases"),
      now,
      client: options.releaseClient,
    });
  let discoveryVersion = initial.version ?? "0.0.0";
  let releases: AssistantReleaseDiscoveryService =
    options.releases ?? createReleases(discoveryVersion);
  let discoveryRefresh: Promise<void> | undefined;
  async function refreshDiscovery(
    state: InstalledDeploymentState,
  ): Promise<void> {
    if (!state.managed || !state.version || options.releases) return;
    if (discoveryRefresh) await discoveryRefresh;
    if (state.version === discoveryVersion) return;
    discoveryRefresh = (async () => {
      const version = state.version!;
      const next = createReleases(version);
      try {
        await next.start();
      } catch (error) {
        next.dispose();
        throw error;
      }
      releases.dispose();
      releases = next;
      discoveryVersion = version;
    })();
    try {
      await discoveryRefresh;
    } finally {
      discoveryRefresh = undefined;
    }
  }
  const jobs = options.jobs ?? createDockerUpdaterJobLauncher(options);
  async function reconcile(): Promise<void> {
    // Snapshot after an in-flight launch finishes, so a not-yet-created job
    // cannot be mistaken for an interrupted operation.
    const op = await locked(options.updaterDirectory, () =>
      currentOperation(options.updaterDirectory),
    );
    if (!assistantUpdateIsActive(op) || !op) return;
    // Never hold the progress lock across Docker I/O. A slow daemon must not
    // starve the worker's durable progress/reconnecting barrier.
    const state = await jobs.inspect(op.id);
    if (state === "running") return;
    await locked(options.updaterDirectory, async () => {
      const fresh = await currentOperation(options.updaterDirectory);
      if (
        !fresh ||
        fresh.id !== op.id ||
        fresh.updatedAt !== op.updatedAt ||
        fresh.phase !== op.phase ||
        !assistantUpdateIsActive(fresh)
      )
        return;
      await saveOperation(options.updaterDirectory, {
        ...fresh,
        phase: "interrupted",
        updatedAt: now(),
        completedAt: now(),
        error: "update_interrupted",
      });
    });
  }
  async function status(): Promise<AssistantUpdateStatus> {
    let reconciliationError = false;
    try {
      await reconcile();
    } catch {
      reconciliationError = true;
    }
    const state = await installed();
    // A supervisor may restart while metadata and release.env are being
    // switched. Recover discovery once a consistent installed identity returns.
    await refreshDiscovery(state);
    return {
      configured: true,
      managed: state.managed,
      installedVersion: state.version,
      installedCommit: state.commit,
      updaterProtocol: 1,
      canRollback: state.managed && Boolean(state.rollbackVersion),
      rollbackVersion: state.managed ? state.rollbackVersion : null,
      discovery: state.managed
        ? releases.snapshot()
        : {
            ...releases.snapshot(),
            status: "unsupported",
            error: "update_source_build_unmanaged",
          },
      operation: await currentOperation(options.updaterDirectory),
      ...(!state.managed
        ? { error: "update_source_build_unmanaged" }
        : reconciliationError
          ? { error: "update_job_status_unavailable" }
          : {}),
    };
  }
  async function begin(
    kind: "update" | "rollback",
    body: UpdateConfirmation,
  ): Promise<void> {
    await locked(options.updaterDirectory, async () => {
      if (
        assistantUpdateIsActive(
          await currentOperation(options.updaterDirectory),
        )
      )
        throw new HttpError(409, "update_operation_active");
      const state = await installed();
      if (!state.managed || !state.version)
        throw new HttpError(409, "update_source_build_unmanaged");
      requirePinnedJobImage();
      if (body.expectedInstalledVersion !== state.version)
        throw new HttpError(409, "update_installed_version_changed");
      if (kind === "update") {
        if (compareReleaseVersions(body.version, state.version) <= 0)
          throw new HttpError(409, "update_downgrade_forbidden");
        const discovery = releases.snapshot();
        if (
          !discovery.releases.some(
            (release) =>
              release.version === body.version &&
              (release.channel === "stable" || discovery.includePreviews),
          )
        )
          throw new HttpError(409, "update_release_unavailable");
      } else if (
        !state.rollbackVersion ||
        state.rollbackVersion !== body.version
      )
        throw new HttpError(409, "update_rollback_unavailable");
      const operation: AssistantUpdateOperation = {
        id: randomUUID(),
        kind,
        fromVersion: state.version,
        targetVersion: body.version,
        phase: "queued",
        startedAt: now(),
        updatedAt: now(),
      };
      await saveOperation(options.updaterDirectory, operation);
      await writeFileAtomic(
        path.join(options.updaterDirectory, "current-operation.json"),
        `${JSON.stringify({ id: operation.id })}\n`,
      );
      // Persist first. A lost launch response must never trigger a second job.
      try {
        await jobs.launch(operation);
      } catch {
        /* GET inspects the named job before deciding interruption. */
      }
    });
  }
  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const authorization = request.headers.authorization;
    const token =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : undefined;
    if (!tokensMatch(options.token, token)) {
      request.resume();
      throw new HttpError(401, "unauthorized");
    }
    const url = new URL(request.url ?? "/", "http://updater.invalid");
    if (url.search) throw new HttpError(400, "update_request_invalid");
    if (url.pathname === "/v1/updates" && request.method === "GET") {
      request.resume();
      sendJson(response, 200, { status: await status() });
      return;
    }
    const action = url.pathname.slice("/v1/updates/".length);
    if (
      !url.pathname.startsWith("/v1/updates/") ||
      !["check", "preferences", "apply", "rollback"].includes(action)
    )
      throw new HttpError(404, "not_found");
    if (request.method !== "POST")
      throw new HttpError(405, "method_not_allowed");
    const body = validateUpdateBody(
      action as "check" | "preferences" | "apply" | "rollback",
      await readJsonBody(request, 2048),
    );
    if (action === "check") {
      if ((await installed()).managed) await releases.check(true);
    } else if (action === "preferences") {
      if (!(await installed()).managed)
        throw new HttpError(409, "update_source_build_unmanaged");
      await releases.setPreferences(body as UpdatePreferences);
    } else
      await begin(
        action === "apply" ? "update" : "rollback",
        body as UpdateConfirmation,
      );
    sendJson(
      response,
      action === "apply" || action === "rollback" ? 202 : 200,
      { status: await status() },
    );
  }
  // Reconcile before listening. A running job is retained across manager restarts.
  await reconcile().catch(() => undefined);
  if (initial.managed) await releases.start();
  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      request.resume();
      if (!response.headersSent)
        sendJson(response, error instanceof HttpError ? error.status : 503, {
          error: error instanceof HttpError ? error.code : "update_unavailable",
        });
      else response.destroy();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 7900, options.host ?? "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    releases.dispose();
    throw error;
  }
  const timer =
    options.schedule === false
      ? undefined
      : setInterval(() => {
          void reconcile().catch(() => undefined);
        }, 5000);
  timer?.unref();
  return {
    address: server.address() as AddressInfo,
    async close() {
      if (timer) clearInterval(timer);
      releases.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Fixed Docker Engine calls only. Docker socket access is root-equivalent. */
export function createDockerUpdaterJobLauncher(
  options: Pick<
    AssistantUpdaterOptions,
    "deployDirectory" | "updaterDirectory" | "jobImage" | "dockerSocket"
  >,
): UpdaterJobLauncher {
  validateRoots(options.deployDirectory, options.updaterDirectory);
  const socket = options.dockerSocket ?? "/var/run/docker.sock";
  if (
    !path.isAbsolute(socket) ||
    socket.includes("\0") ||
    /[\r\n:]/u.test(socket)
  )
    throw new Error("update_socket_invalid");
  const image = options.jobImage ?? "agentlink-updater:local";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,255}$/.test(image))
    throw new Error("update_image_invalid");
  const name = (id: string) => {
    if (!UUID.test(id)) throw new Error("update_operation_invalid");
    return `agentlink-updater-job-${id}`;
  };
  async function call(
    method: string,
    route: string,
    body?: unknown,
  ): Promise<{ code: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request(
        {
          socketPath: socket,
          method,
          path: `/v1.41${route}`,
          headers: payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {},
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024) {
              response.destroy();
              reject(new Error("update_docker_response_invalid"));
            } else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            try {
              const text = Buffer.concat(chunks).toString("utf8");
              resolve({
                code: response.statusCode ?? 500,
                body: text ? (JSON.parse(text) as unknown) : null,
              });
            } catch {
              reject(new Error("update_docker_response_invalid"));
            }
          });
        },
      );
      request.setTimeout(15_000, () =>
        request.destroy(new Error("update_docker_timeout")),
      );
      request.on("error", reject);
      request.end(payload);
    });
  }
  return {
    async inspect(id) {
      const result = await call("GET", `/containers/${name(id)}/json`);
      if (result.code === 404) return "missing";
      if (result.code !== 200) throw new Error("update_docker_unavailable");
      const state = result.body as {
        Config?: { Labels?: Record<string, string> };
        State?: { Running?: boolean };
      };
      if (
        state.Config?.Labels?.[LABEL] !== id ||
        typeof state.State?.Running !== "boolean"
      )
        throw new Error("update_docker_identity_invalid");
      return state.State.Running ? "running" : "stopped";
    },
    async launch(operation) {
      const result = await call(
        "POST",
        `/containers/create?name=${name(operation.id)}`,
        {
          Image: image,
          Entrypoint: ["agentlink-server"],
          Cmd: [
            "updater-job",
            "--deploy-root",
            options.deployDirectory,
            "--updater-root",
            options.updaterDirectory,
            "--operation",
            operation.id,
          ],
          User: "0:0",
          StopTimeout: 600,
          Env: [`DOCKER_HOST=unix://${socket}`],
          Labels: { [LABEL]: operation.id },
          HostConfig: {
            Init: true,
            Binds: [
              `${options.deployDirectory}:${options.deployDirectory}:rw`,
              `${options.updaterDirectory}:${options.updaterDirectory}:rw`,
              `${socket}:${socket}:rw`,
            ],
            NetworkMode: "agentlink-updater-egress",
            RestartPolicy: { Name: "no" },
            AutoRemove: false,
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            CapAdd: ["DAC_OVERRIDE", "CHOWN"],
            SecurityOpt: ["no-new-privileges:true"],
            Tmpfs: { "/tmp": "rw,nosuid,nodev,size=256m" },
          },
        },
      );
      // A name conflict is never a reason to restart an existing job.
      if (result.code !== 201) throw new Error("update_job_launch_failed");
      const started = await call(
        "POST",
        `/containers/${name(operation.id)}/start`,
      );
      if (started.code !== 204) throw new Error("update_job_launch_failed");
    },
  };
}

export interface UpdaterJobOptions {
  deployDirectory: string;
  updaterDirectory: string;
  operation: string;
  now?: () => number;
  runUpdate?: typeof runDeploymentUpdate;
  runRollback?: typeof runDeploymentRollback;
}
/** Foreground CLI worker, deliberately independent of the app and updater service lifetimes. */
export async function runUpdaterJob(options: UpdaterJobOptions): Promise<void> {
  validateRoots(options.deployDirectory, options.updaterDirectory);
  operationFile(options.updaterDirectory, options.operation);
  await withFileLock(
    path.join(options.updaterDirectory, `worker-${options.operation}.lock`),
    async () => {
      const operation = await readOperation(
        options.updaterDirectory,
        options.operation,
      );
      if (operation.phase !== "queued")
        throw new Error("update_job_already_started");
      const now = options.now ?? Date.now;
      const progress = async (phase: AssistantUpdatePhase) => {
        if (
          !PHASES.includes(phase) ||
          ASSISTANT_TERMINAL_UPDATE_PHASES.includes(phase)
        )
          throw new Error("update_phase_invalid");
        await locked(options.updaterDirectory, async () => {
          const fresh = await readOperation(
            options.updaterDirectory,
            operation.id,
          );
          if (!assistantUpdateIsActive(fresh))
            throw new Error("update_operation_not_active");
          await saveOperation(options.updaterDirectory, {
            ...fresh,
            phase,
            updatedAt: now(),
          });
        });
      };
      try {
        await progress(
          operation.kind === "rollback" ? "rolling_back" : "downloading",
        );
        const run =
          operation.kind === "rollback"
            ? (options.runRollback ?? runDeploymentRollback)
            : (options.runUpdate ?? runDeploymentUpdate);
        await run({
          deployDirectory: options.deployDirectory,
          updaterDirectory: options.updaterDirectory,
          operation,
          onProgress: progress,
        });
        await locked(options.updaterDirectory, async () => {
          const fresh = await readOperation(
            options.updaterDirectory,
            operation.id,
          );
          if (!assistantUpdateIsActive(fresh))
            throw new Error("update_operation_not_active");
          await saveOperation(options.updaterDirectory, {
            ...fresh,
            phase: "completed",
            updatedAt: now(),
            completedAt: now(),
          });
        });
      } catch {
        await locked(options.updaterDirectory, async () => {
          const fresh = await readOperation(
            options.updaterDirectory,
            operation.id,
          );
          if (assistantUpdateIsActive(fresh))
            await saveOperation(options.updaterDirectory, {
              ...fresh,
              phase: "failed",
              updatedAt: now(),
              completedAt: now(),
              error: "update_job_failed",
            });
        });
        throw new Error("update_job_failed");
      }
    },
    { timeoutMs: 0 },
  );
}
