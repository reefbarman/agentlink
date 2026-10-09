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
  createServerCodexRuntime,
  describeCodexSignIn,
  hasCodexProvider,
} from "./codexSignIn.js";
import {
  FileLockHeldError,
  acquireFileLock,
  releaseFileLock,
} from "./fileLock.js";
import {
  ensureLocalServerCertificate,
  localTlsHostsFromOrigins,
  readLocalCertificateAuthority,
  type LocalServerCertificate,
} from "./localCertificateAuthority.js";
import {
  configuredModels,
  resolveWorkspaceProviders,
  usesLocalCa,
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
  /** Clock for local certificate issuance and renewal; tests only. */
  readonly now?: () => number;
  /** How often the local server certificate is re-checked (default 12h). */
  readonly certificateCheckIntervalMs?: number;
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

/** Where the server-managed local CA and server certificate live. */
export function serverTlsDirectory(config: AssistantServerConfig): string {
  return path.join(config.dataRoot, "tls");
}

export type AssistantServicePreflight = (
  | {
      readonly kind: "files";
      readonly tls: { readonly cert: Buffer; readonly key: Buffer };
    }
  | {
      readonly kind: "local-ca";
      /** Undefined until the first start creates the CA. */
      readonly caFingerprint256?: string;
    }
) & {
  /** Present when a codex provider is configured. */
  readonly codexSignIn?: string;
};

/**
 * Check everything that can be checked without taking locks, listening, or
 * creating anything: TLS material and permissions (or the existing local
 * CA), project directories, and provider secrets.
 */
export async function preflightAssistantService(
  config: AssistantServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AssistantServicePreflight> {
  let result: AssistantServicePreflight;
  if (usesLocalCa(config.tls)) {
    const existing = await readLocalCertificateAuthority({
      directory: serverTlsDirectory(config),
      hosts: localTlsHostsFromOrigins(config.publicOrigins),
    });
    result = {
      kind: "local-ca",
      ...(existing ? { caFingerprint256: existing.fingerprint256 } : {}),
    };
  } else {
    result = { kind: "files", tls: await readTlsFiles(config.tls) };
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
  if (hasCodexProvider(config)) {
    // A missing sign-in is reported, not fatal: the server can start and be
    // signed in afterwards without a restart.
    const codex = createServerCodexRuntime(config);
    await resolveWorkspaceProviders(config.providers, env, {
      codexCredentialProvider: codex.provider,
    });
    return { ...result, codexSignIn: await describeCodexSignIn(codex) };
  }
  await resolveWorkspaceProviders(config.providers, env);
  return result;
}

async function readTlsFiles(tls: {
  readonly certFile: string;
  readonly keyFile: string;
}): Promise<{ cert: Buffer; key: Buffer }> {
  const cert = await readRequired(tls.certFile, "tls.certFile");
  const keyStat = await fs.stat(tls.keyFile).catch((error: unknown) => {
    throw new Error(`Cannot read tls.keyFile: ${message(error)}`);
  });
  // Group read is allowed for the Debian `ssl-cert` convention (0640).
  if ((keyStat.mode & 0o007) !== 0) {
    throw new Error(
      `tls.keyFile (${tls.keyFile}) must not be accessible by others (chmod 600 or 640)`,
    );
  }
  const key = await readRequired(tls.keyFile, "tls.keyFile");
  try {
    createSecureContext({ cert, key, minVersion: "TLSv1.2" });
  } catch (error) {
    throw new Error(`TLS certificate or key is unusable: ${message(error)}`);
  }
  return { cert, key };
}

const CERTIFICATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const TLS_LOCK_FILE = "tls.lock";

/**
 * Issue the local server certificate and keep it current: re-check on an
 * interval and hot-swap a renewed certificate into the running listener.
 */
async function startLocalCertificates(
  config: AssistantServerConfig,
  options: AssistantServiceOptions,
): Promise<{
  readonly tls: { readonly cert: string; readonly key: string };
  watch(server: AssistantServer): void;
  stop(): Promise<void>;
}> {
  const { log } = options;
  const directory = serverTlsDirectory(config);
  // Hold the TLS directory for the life of the service, so a second process
  // cannot create or renew certificates alongside this one.
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, TLS_LOCK_FILE);
  let lockToken: string;
  try {
    lockToken = await acquireFileLock(lockPath);
  } catch (error) {
    if (error instanceof FileLockHeldError) {
      throw new Error(
        `Another agentlink-server process is using ${directory}; stop it first. A lock left by a crash is replaced automatically (after up to a minute if it came from another container); one written by an older version must be deleted by hand: ${lockPath}`,
      );
    }
    throw error;
  }
  const ensure = () =>
    ensureLocalServerCertificate({
      directory,
      hosts: localTlsHostsFromOrigins(config.publicOrigins),
      ...(options.now ? { now: options.now } : {}),
    });
  const reportIssued = (issued: LocalServerCertificate) => {
    if (issued.createdCa) {
      log(
        [
          "Created a local certificate authority for this server.",
          `CA SHA-256 fingerprint: ${issued.caFingerprint256}`,
          "Install it on each device with `agentlink-server export-ca` (see README).",
        ].join("\n"),
      );
    }
    if (issued.issuedLeaf) {
      log(
        `Issued server certificate valid until ${issued.notAfter.toISOString()}`,
      );
    }
  };
  let first: LocalServerCertificate;
  try {
    first = await ensure();
  } catch (error) {
    await releaseFileLock(lockPath, lockToken);
    throw error;
  }
  reportIssued(first);
  if (!first.createdCa) {
    log(`Local CA SHA-256 fingerprint: ${first.caFingerprint256}`);
  }
  let timer: NodeJS.Timeout | undefined;
  let checking = false;
  return {
    tls: { cert: first.certificatePem, key: first.privateKeyPem },
    watch(server) {
      timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void ensure()
          .finally(() => {
            checking = false;
          })
          .then(
            (issued) => {
              reportIssued(issued);
              if (issued.issuedLeaf) {
                server.setTls({
                  cert: issued.certificatePem,
                  key: issued.privateKeyPem,
                });
              }
            },
            (error: unknown) => {
              log(`Server certificate renewal failed: ${message(error)}`);
            },
          );
      }, options.certificateCheckIntervalMs ?? CERTIFICATE_CHECK_INTERVAL_MS);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      while (checking) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await releaseFileLock(lockPath, lockToken);
    },
  };
}

export async function startAssistantService(
  options: AssistantServiceOptions,
): Promise<AssistantService> {
  const { config, log } = options;
  const env = options.env ?? process.env;
  const preflight = await preflightAssistantService(config, env);
  await fs.mkdir(config.dataRoot, { recursive: true, mode: 0o700 });
  const certificates =
    preflight.kind === "local-ca"
      ? await startLocalCertificates(config, options)
      : undefined;
  const tls = preflight.kind === "files" ? preflight.tls : certificates!.tls;
  const codex = hasCodexProvider(config)
    ? createServerCodexRuntime(config, log)
    : undefined;
  if (preflight.codexSignIn) log(preflight.codexSignIn);
  const providers = await resolveWorkspaceProviders(
    config.providers,
    env,
    codex ? { codexCredentialProvider: codex.provider } : {},
  );
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
  // Bound once the routes exist; children cannot start before then.
  let agentNotifier:
    | Pick<
        ReturnType<typeof createAssistantWorkspaceRoutes>,
        "notifyAgentApproval" | "notifyAgentChange"
      >
    | undefined;
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
        // Children are one level deep, use the parent's model unless a role
        // (for example `review`) is requested, and pause for the owner's
        // approval like the parent does.
        background: {
          enabled: true,
          ...(config.modelRoles ? { modelRoles: config.modelRoles } : {}),
          onApprovalAvailable: ({ parentSessionId, childSessionId }) =>
            agentNotifier?.notifyAgentApproval({
              projectId: project.id,
              parentSessionId,
              childSessionId,
            }),
          onAgentChanged: (change) =>
            agentNotifier?.notifyAgentChange({
              ...change,
              projectId: project.id,
            }),
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
      models: {
        available: configuredModels(config),
        defaultModel: config.defaultModel,
        ...(config.modelRoles ? { roles: config.modelRoles } : {}),
      },
    });
    agentNotifier = routes;
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
    certificates?.watch(server);
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
          await certificates?.stop();
        })();
        return closing;
      },
    };
  } catch (error) {
    recovery.stop();
    await server?.close().catch(() => undefined);
    await recovery.settled();
    await closeHosts();
    await certificates?.stop();
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
