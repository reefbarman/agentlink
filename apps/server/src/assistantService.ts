import type { AgentModelReference, HostToolResolver } from "@agentlink/core";
import { createNodeHostLocalFileSystem } from "@agentlink/node-host";
import {
  createLocalWorkspaceExecutionBackend,
  createWorkspaceHost,
  createWorkspaceModelBackend,
  type CreateWorkspaceHostOptions,
  type WorkspaceHost,
} from "@agentlink/workspace-host";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createSecureContext } from "node:tls";

import { renderBrowserGatewayIndexHtml } from "../../../src/browser-gateway/browserGatewayPages.js";
import {
  createAskAgentBridge,
  modelKey,
  type AskAgentBridge,
} from "./askAgentBridge.js";
import {
  createAssistantServer,
  type AssistantServer,
  type AssistantServerAuth,
} from "./assistantServer.js";
import {
  createServerCodexRuntime,
  describeCodexSignIn,
  hasCodexProvider,
} from "./codexSignIn.js";
import {
  canExecuteOnCommandWorker,
  createCommandWorkerLauncher,
  pingCommandWorker,
  type CommandWorkerClientOptions,
} from "./commandWorkerClient.js";
import {
  FileLockHeldError,
  acquireFileLock,
  releaseFileLock,
} from "./fileLock.js";
import type { RemoteWorkspaceHost } from "./remoteWorkspaceHost.js";
import { createRunnerManagerClient } from "./runnerManager.js";
import {
  startSessionRunnerPool,
  type SessionRunnerPool,
} from "./sessionRunners.js";
import {
  ensureLocalServerCertificate,
  localTlsHostsFromOrigins,
  readLocalCertificateAuthority,
  type LocalServerCertificate,
} from "./localCertificateAuthority.js";
import {
  configuredModels,
  prepareSecret,
  resolveWorkspaceProviders,
  usesLocalCa,
  type AssistantServerConfig,
} from "./serverConfig.js";
import { openFileSessionEventLog } from "./FileSessionEventLog.js";
import { openSessionApprovalModes } from "./SessionApprovalModes.js";
import { createJobRoutes } from "./jobRoutes.js";
import { createJobRunner, type JobRunner } from "./jobRunner.js";
import { createJobTools } from "./jobTools.js";
import { createTurnFailureLog, describeTurnFailure } from "./turnFailures.js";
import { serverTimeZone } from "./jobSchedule.js";
import {
  isActiveRun,
  openJobStore,
  type JobDefinition,
  type JobRun,
} from "./jobStore.js";
import { createInboxRoutes } from "./inboxRoutes.js";
import {
  inboxEntryForRun,
  inboxEntryForSessionAlert,
  inboxEntryForTask,
  openInboxStore,
  type NewInboxEntry,
} from "./inboxStore.js";
import { createPushRoutes } from "./pushRoutes.js";
import { AUTO_CONTINUE_INSTRUCTIONS } from "./sessionProgress.js";
import { createSessionWatch } from "./sessionWatch.js";
import {
  connectorPushTransport,
  openPushService,
  pushMessageForEntry,
  type PushTransport,
} from "./pushService.js";
import {
  DEFAULT_NETWORK_POLICY,
  egressProxyUrl,
  parseNetworkPolicyKey,
  proxyAuthorizationHeader,
  type NetworkPolicy,
} from "./egressPolicy.js";
import { directConnector, gatewayConnector } from "./webFetch.js";
import { createWebTools } from "./webTools.js";
import { createProjectChats } from "./projectChats.js";
import { openProjectCatalog, projectNetworkPolicy } from "./projectCatalog.js";
import { createGitCloner } from "./projectClone.js";
import {
  createGitCommand,
  createProcessRunner,
  type GitCommandOptions,
} from "./gitCommand.js";
import { openRepositorySettings } from "./taskRepositories.js";
import { pickReviewModel } from "./taskReview.js";
import { createTaskRoutes } from "./taskRoutes.js";
import { openGitHubConnections } from "./githubConnections.js";
import { createGitHubRoutes } from "./githubRoutes.js";
import { createRepositoryDirectory } from "./githubRepositories.js";
import {
  assistantRoutingInstructions,
  createRepositoryTools,
} from "./repositoryTools.js";
import { HttpError } from "./httpJson.js";
import { createPublisherClient } from "./publisherClient.js";
import { createTaskRunner, type TaskRunner } from "./taskRunner.js";
import { isActiveTask, openTaskStore, type TaskRun } from "./taskStore.js";
import { combineApprovalHostTools, createTaskTools } from "./taskTools.js";
import { openRepositorySnapshots } from "./repositorySnapshots.js";
import {
  chatTaskCards,
  openTaskDeliveries,
  workNotice,
} from "./taskResultDelivery.js";
import { createTaskWorkspaces } from "./taskWorkspace.js";
import { bundledWebAssets } from "./webAssets.js";
import {
  createAssistantWorkspaceRoutes,
  ownerProjectAccess,
  parseSessionKey,
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
  /** Replaces sending to the push services; tests only. */
  readonly pushTransport?: PushTransport;
}

export interface AssistantService {
  readonly server: AssistantServer;
  readonly port: number;
  /** Stops turns, closes connections, releases the data-root lock and hosts. */
  close(): Promise<void>;
}

/**
 * How much one turn may do: no limit (zero), for chats and tasks alike, as
 * in VS Code. The core's defaults for headless turns (16 model calls, 64
 * tool calls, 5 minutes) would cut real work short. Work runs until it is
 * done or the owner stops it; the runaway guard (`sessionWatch.ts`) only
 * tells the owner when something runs long or looks stuck.
 */
export const SESSION_TURN_LIMITS = {
  maxModelCalls: 0,
  maxToolCalls: 0,
  maxElapsedMs: 0,
  maxToolResultBytes: 0,
} as const;

/** Where the access store (owner, devices, sessions) lives under the data root. */
export function serverAccessDataRoot(config: AssistantServerConfig): string {
  return path.join(config.dataRoot, "server");
}

/** Where session event logs live, for replay across restarts. */
export function serverEventLogDirectory(config: AssistantServerConfig): string {
  return path.join(config.dataRoot, "events");
}

/** Per-session approval modes (which sessions ask for everything). */
export function serverApprovalModesFile(config: AssistantServerConfig): string {
  return path.join(config.dataRoot, "settings", "approval-modes.json");
}

/**
 * UI-only state of one project's chats (session titles, hidden sessions).
 * The first configured project keeps the file from before projects existed.
 */
export function serverAskAgentStateFile(
  config: AssistantServerConfig,
  projectId?: string,
): string {
  return projectId === undefined
    ? path.join(config.dataRoot, "settings", "ask-agent-state.json")
    : path.join(config.dataRoot, "settings", "chats", `${projectId}.json`);
}

/** Projects created from the app, and every project's settings. */
export function serverProjectCatalogFile(
  config: AssistantServerConfig,
): string {
  return path.join(config.dataRoot, "settings", "projects.json");
}

/** Scheduled job definitions and run history. */
export function serverJobsDirectory(config: AssistantServerConfig): string {
  return path.join(config.dataRoot, "jobs");
}

/** The owner's inbox of job results and approvals waiting. */
export function serverInboxDirectory(config: AssistantServerConfig): string {
  return path.join(config.dataRoot, "inbox");
}

/** Coding task records and their state history. */
export function serverTasksDirectory(config: AssistantServerConfig): string {
  return path.join(config.dataRoot, "tasks");
}

/** VAPID keys and the devices' push subscriptions. */
export function serverPushDirectory(config: AssistantServerConfig): string {
  return path.join(config.dataRoot, "push");
}

/** git where clones run: the command worker image, or this machine. */
const GIT_EXECUTABLE = "/usr/bin/git";

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
  /** Present when a command worker is configured. */
  readonly commandWorker?: string;
  /** Present when a publisher is configured. */
  readonly publisher?: string;
  /** Present when session runners are configured. */
  readonly runners?: string;
};

/**
 * The only environment commands get on the worker. Nothing from the server
 * process (provider keys, credential paths) is forwarded.
 */
export const COMMAND_WORKER_ENVIRONMENT: Readonly<Record<string, string>> = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/tmp",
  LANG: "C.UTF-8",
  TERM: "dumb",
  // pnpm and yarn come through Corepack, which fetches the version a
  // repository asks for on first use: never stop to ask, nobody can answer.
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  // No terminal is attached: tools that would stop to ask (pnpm removing a
  // modules folder, for one) must take their non-interactive path instead.
  CI: "true",
};

/**
 * The environment for one command: the fixed base, plus the egress gateway
 * as both spellings of each proxy variable (curl reads only lowercase
 * `http_proxy`; npm, pip and git read either).
 */
export function commandWorkerEnvironment(
  egressProxy: string | undefined,
): Record<string, string> {
  return {
    ...COMMAND_WORKER_ENVIRONMENT,
    ...(egressProxy
      ? {
          HTTPS_PROXY: egressProxy,
          https_proxy: egressProxy,
          HTTP_PROXY: egressProxy,
          http_proxy: egressProxy,
        }
      : {}),
  };
}

async function commandWorkerClient(
  config: AssistantServerConfig,
  env: NodeJS.ProcessEnv,
): Promise<CommandWorkerClientOptions | undefined> {
  if (!config.commandWorker) return undefined;
  return {
    host: config.commandWorker.host,
    port: config.commandWorker.port,
    readToken: await prepareSecret(
      config.commandWorker.token,
      "commandWorker.token",
      env,
    ),
  };
}

/**
 * Host options that run every process on the command worker, or disable
 * commands when none is configured. Files stay local to this server.
 */
/**
 * `web_fetch` and `web_search` for one project. Pages are read through the
 * egress gateway with the project's signed policy when there is one (the
 * same rules as its commands), otherwise the server makes the same checks
 * and connects itself.
 */
export function projectWebTools(
  config: AssistantServerConfig,
  options: {
    readonly policy: () => NetworkPolicy;
    readonly key: Buffer | undefined;
    readonly codex?: Pick<
      ReturnType<typeof createServerCodexRuntime>["provider"],
      "resolveAuth"
    >;
  },
): HostToolResolver {
  const proxy = config.commandWorker?.egressProxy;
  const key = options.key;
  const codex = options.codex;
  const codexProviderIds = new Set(
    config.providers
      .filter((provider) => provider.type === "codex")
      .map((provider) => provider.id ?? "codex"),
  );
  return createWebTools({
    policy: options.policy,
    connector: proxy
      ? gatewayConnector({
          proxy,
          authorization: (policy) =>
            key ? proxyAuthorizationHeader(key, policy) : undefined,
        })
      : directConnector(),
    ...(codex && codexProviderIds.size > 0
      ? {
          codex: {
            providerIds: codexProviderIds,
            resolveAuth: () =>
              codex.resolveAuth({
                context: undefined as never,
                modelId: "",
                purpose: "nativeWeb",
              }),
          },
        }
      : {}),
    ...(config.web?.searxngUrl ? { searxngUrl: config.web.searxngUrl } : {}),
  });
}

export function commandHostOptions(
  config: Pick<AssistantServerConfig, "commandWorker">,
  client: CommandWorkerClientOptions | undefined,
  /** Whether a foreground command in this session may run without asking. */
  autonomous?: (request: { readonly sessionId: string }) => boolean,
  /**
   * The project's network policy, read for each command, and the key that
   * signs it into the proxy credentials. Without a key the gateway's own
   * allowlist applies.
   */
  network?: {
    readonly policy: () => NetworkPolicy;
    readonly key: Buffer | undefined;
  },
): Pick<CreateWorkspaceHostOptions, "executionBackend" | "commands"> {
  if (!client || !config.commandWorker) return {};
  return {
    executionBackend: {
      // Project files are read and written here. Only "can this binary run"
      // (ripgrep, git) is asked where processes actually run.
      fileSystem: {
        ...createNodeHostLocalFileSystem(),
        canExecute: (target) => canExecuteOnCommandWorker(client, target),
      },
      ...createCommandWorkerLauncher(client),
    },
    commands: {
      enabled: true,
      shellExecutable: config.commandWorker.shell,
      resolveEnvironment: () => {
        const proxy = config.commandWorker?.egressProxy;
        return commandWorkerEnvironment(
          proxy && network
            ? egressProxyUrl(proxy, network.key, network.policy())
            : proxy,
        );
      },
      ...(autonomous
        ? { hasSessionGrant: (_proposal, request) => autonomous(request) }
        : {}),
    },
  };
}

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
  // With a worker, ripgrep runs there and cannot be checked from here.
  if (config.ripgrepPath && !config.commandWorker) {
    await fs.access(config.ripgrepPath, fs.constants.X_OK).catch(() => {
      throw new Error(`ripgrepPath is not executable: ${config.ripgrepPath}`);
    });
  }
  const worker = await commandWorkerClient(config, env);
  if (worker) {
    // Reported, not fatal: the worker may start after the server.
    const ping = await pingCommandWorker({
      ...worker,
      connectTimeoutMs: 3_000,
    });
    result = {
      ...result,
      commandWorker: ping.ok
        ? `Command worker: reachable at ${worker.host}:${worker.port}`
        : `Command worker: not reachable at ${worker.host}:${worker.port} (${ping.code}); commands and search fail until it is`,
    };
  }
  if (config.publisher) {
    const { host, port } = config.publisher;
    // Reported, not fatal: tasks stop at ready until it is reachable.
    const client = createPublisherClient({
      host,
      port,
      token: await prepareSecret(
        config.publisher.token,
        "publisher.token",
        env,
      ),
      timeoutMs: 3_000,
    });
    let publisherStatus: string;
    try {
      const health = await client.health();
      publisherStatus = `Publisher: reachable at ${host}:${port}; ${health.deviceFlow ? "Connect GitHub uses the GitHub App" : "no GitHub App client ID, so only pasted tokens can connect"}`;
    } catch (error) {
      publisherStatus = `Publisher: not reachable at ${host}:${port} (${error instanceof Error ? error.message : String(error)}); tasks stop at ready until it is`;
    }
    result = { ...result, publisher: publisherStatus };
  }
  if (config.runners) {
    const { host, port } = config.runners.manager;
    const manager = createRunnerManagerClient({
      host,
      port,
      readToken: await prepareSecret(
        config.runners.manager.token,
        "runners.manager.token",
        env,
      ),
    });
    let runnersStatus: string;
    try {
      await manager.ping();
      runnersStatus = config.projectsRoot
        ? `Session runners: manager reachable at ${host}:${port}; each coding task runs in its own container`
        : `Session runners: manager reachable at ${host}:${port}, but unused without projectsRoot`;
    } catch (error) {
      runnersStatus = `Session runners: manager not reachable at ${host}:${port} (${error instanceof Error ? error.message : String(error)}); coding tasks cannot start until it is`;
    }
    result = { ...result, runners: runnersStatus };
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
  if (preflight.commandWorker) log(preflight.commandWorker);
  if (preflight.runners) log(preflight.runners);
  const worker = await commandWorkerClient(config, env);
  const policyKey = config.commandWorker?.egressPolicyKey
    ? parseNetworkPolicyKey(
        await (
          await prepareSecret(
            config.commandWorker.egressPolicyKey,
            "commandWorker.egressPolicyKey",
            env,
          )
        )(),
      )
    : undefined;
  if (config.commandWorker?.egressProxy && !policyKey) {
    log(
      "No commandWorker.egressPolicyKey: every project's commands get the egress gateway's allowlist, whatever its network preset.",
    );
  }
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

  // Opened before the hosts so a second process stops here, untouched.
  const eventLog = await openFileSessionEventLog({
    directory: serverEventLogDirectory(config),
    log,
  }).catch(async (error: unknown) => {
    await certificates?.stop();
    throw error;
  });
  const approvalModes = await openSessionApprovalModes({
    file: serverApprovalModesFile(config),
  }).catch(async (error: unknown) => {
    await eventLog.close();
    await certificates?.stop();
    throw error;
  });
  const jobStore = await openJobStore({
    directory: serverJobsDirectory(config),
  }).catch(async (error: unknown) => {
    await eventLog.close();
    await certificates?.stop();
    throw error;
  });
  const inbox = await openInboxStore({
    directory: serverInboxDirectory(config),
  }).catch(async (error: unknown) => {
    await eventLog.close();
    await certificates?.stop();
    throw error;
  });
  const taskStore = await openTaskStore({
    directory: serverTasksDirectory(config),
  }).catch(async (error: unknown) => {
    await eventLog.close();
    await certificates?.stop();
    throw error;
  });
  const repositorySettings = await openRepositorySettings({
    file: path.join(serverTasksDirectory(config), "repositories.json"),
  }).catch(async (error: unknown) => {
    await eventLog.close();
    await certificates?.stop();
    throw error;
  });
  // Which GitHub accounts tasks publish with; their tokens stay in the
  // publisher.
  const githubConnections = await openGitHubConnections({
    file: path.join(config.dataRoot, "github", "connections.json"),
  }).catch(async (error: unknown) => {
    await eventLog.close();
    await certificates?.stop();
    throw error;
  });
  const publisher = config.publisher
    ? createPublisherClient({
        host: config.publisher.host,
        port: config.publisher.port,
        token: await prepareSecret(
          config.publisher.token,
          "publisher.token",
          env,
        ),
      })
    : undefined;
  let server: AssistantServer | undefined;
  /** Devices still signed in, once the access store is open. */
  const activeDeviceIds = () =>
    server
      ? new Set(
          server.store
            .listDevices()
            .filter((device) => device.revokedAt === undefined)
            .map((device) => device.deviceId),
        )
      : undefined;
  const egressProxy = config.commandWorker?.egressProxy;
  // Through the egress gateway when there is one, to the push services only.
  const push = await openPushService({
    directory: serverPushDirectory(config),
    transport:
      options.pushTransport ??
      connectorPushTransport(
        egressProxy
          ? gatewayConnector({
              proxy: egressProxy,
              authorization: (policy) =>
                policyKey
                  ? proxyAuthorizationHeader(policyKey, policy)
                  : undefined,
            })
          : directConnector(),
      ),
    ...(config.notifications?.contact
      ? { subject: config.notifications.contact }
      : {}),
    activeDevices: activeDeviceIds,
    log,
  }).catch(async (error: unknown) => {
    await eventLog.close();
    await certificates?.stop();
    throw error;
  });
  const recovery = createSessionRecovery(log);
  let runnerPool: SessionRunnerPool | undefined;
  /** Chat bridges by project, closed by the server once it exists. */
  const bridges = new Map<string, AskAgentBridge>();
  /** Changes when the inbox or a job's runs change; open apps refetch. */
  let assistantRevision = 0;
  const assistantChanged = () => {
    assistantRevision += 1;
    for (const bridge of bridges.values()) bridge.refresh();
  };
  // Bound once the routes exist; children cannot start before then.
  let agentNotifier:
    | Pick<
        ReturnType<typeof createAssistantWorkspaceRoutes>,
        "notifyAgentApproval" | "notifyAgentChange"
      >
    | undefined;
  try {
    const catalog = await openProjectCatalog({
      file: serverProjectCatalogFile(config),
      configProjects: config.projects,
      ...(config.projectsRoot ? { projectsRoot: config.projectsRoot } : {}),
    });
    // Bound once the runner exists; no turn can start before then.
    let jobRunner: JobRunner | undefined;
    let taskRunner: TaskRunner | undefined;
    // Every repository the owner's GitHub connections reach (asked of the
    // publisher), plus configured and project ones.
    const repositoryDirectory = createRepositoryDirectory({
      connections: githubConnections,
      publisher,
      settings: repositorySettings,
      projectRepositories: () =>
        catalog.list().flatMap((project) =>
          project.repositories.map((repository) => ({
            projectId: project.id,
            url: repository.url,
          })),
        ),
      log,
    });
    // Chats can propose coding tasks when there is somewhere to clone them.
    // The card carries proposed checks and, with the publisher, first-time
    // publish permission; both are saved when the owner approves it.
    const taskTools = config.projectsRoot
      ? createTaskTools({
          store: taskStore,
          repositories: repositorySettings,
          // Repeat work in an Auto-run chat starts without a card.
          autonomous: ({ projectId, sessionId }) =>
            approvalModes.get(projectId, sessionId) === "autonomous",
          ...(publisher
            ? { directory: repositoryDirectory, connections: githubConnections }
            : {}),
          runner: {
            create: async (...args) => {
              if (!taskRunner) throw new Error("Tasks are not ready yet");
              return taskRunner.create(...args);
            },
            continueTask: async (...args) => {
              if (!taskRunner) throw new Error("Tasks are not ready yet");
              return taskRunner.continueTask(...args);
            },
          },
          models: configuredModels(config),
        })
      : undefined;
    // Read-only snapshots for read_repository, fetched by the publisher with
    // a connection that reaches the repository (or none: public only). Any
    // reaching connection will do for reading, so an ambiguous one is fine.
    const repositorySnapshots = publisher
      ? await openRepositorySnapshots({
          root: path.join(config.dataRoot, "repository-snapshots"),
          fetchArchive: async (repository, destination) => {
            const resolved =
              await repositoryDirectory.resolveConnection(repository);
            const connectionId =
              resolved.kind === "one"
                ? resolved.connectionId
                : resolved.kind === "ambiguous"
                  ? resolved.connectionIds[0]
                  : undefined;
            return publisher.archive(
              { repository, ...(connectionId ? { connectionId } : {}) },
              destination,
            );
          },
        })
      : undefined;
    // Snapshots are deleted 24 hours after they were fetched, used or not.
    const snapshotSweep = repositorySnapshots
      ? setInterval(
          () => {
            repositorySnapshots.sweep().catch((error: unknown) => {
              log(`assistant: snapshot sweep failed: ${String(error)}`);
            });
          },
          60 * 60 * 1_000,
        )
      : undefined;
    snapshotSweep?.unref();
    const repositoryTools = createRepositoryTools({
      directory: repositoryDirectory,
      connections: githubConnections,
      ...(repositorySnapshots
        ? {
            snapshots: repositorySnapshots,
            reaches: async (repository: string) =>
              (await repositoryDirectory.resolveConnection(repository)).kind !==
              "none",
          }
        : {}),
    });
    // How a chat routes requests to the right tool, without asking.
    const routingInstructions = assistantRoutingInstructions({
      tasks: taskTools !== undefined,
      repositories: true,
      read: repositorySnapshots !== undefined,
    });
    /** Why turns failed, beyond the public error code; owner-only. */
    const turnFailures = createTurnFailureLog();
    const openHost = async (
      project: {
        readonly id: string;
        readonly root: string;
        /** Commands run only inside this folder (a task's clone). */
        readonly commandRoot?: string;
      },
      /** A coding task's own folder: web tools only, no jobs or tasks. */
      kind: "project" | "task" = "project",
    ) => {
      const autonomous = (request: { readonly sessionId: string }) =>
        approvalModes.get(project.id, request.sessionId) === "autonomous";
      const commandOptions = commandHostOptions(config, worker, autonomous, {
        policy: () => projectNetworkPolicy(catalog.get(project.id)),
        key: policyKey,
      });
      const webTools = projectWebTools(config, {
        policy: () => projectNetworkPolicy(catalog.get(project.id)),
        key: policyKey,
        ...(codex ? { codex: codex.provider } : {}),
      });
      // Chats can propose jobs; the owner approves each exact change.
      const jobTools = createJobTools({
        projectId: project.id,
        store: jobStore,
        runner: {
          jobChanged: async (jobId) => {
            await jobRunner?.jobChanged(jobId);
          },
          stopJob: async (jobId, reason) => {
            await jobRunner?.stopJob(jobId, reason);
          },
        },
        projectIds: () => [...bridges.keys()],
        projectLabel: (projectId) => catalog.get(projectId)?.label,
        models: configuredModels(config),
        defaultTimeZone: serverTimeZone(),
        onChanged: () => assistantChanged(),
      });
      const host = await createWorkspaceHost({
        projectRoot: project.root,
        dataRoot: path.join(config.dataRoot, "workspace"),
        ownerId,
        providers,
        defaultModel: config.defaultModel,
        promptIdentity: { role: "a personal assistant" },
        turnLimits: SESSION_TURN_LIMITS,
        // The todo list, for Auto Continue; no ask_user (approval cards and
        // messages are how a chat reaches the owner).
        sessionInteractions: {},
        instructions:
          kind === "project"
            ? `${routingInstructions}\n\n${AUTO_CONTINUE_INSTRUCTIONS}`
            : AUTO_CONTINUE_INSTRUCTIONS,
        ...commandOptions,
        ...(commandOptions.commands && project.commandRoot
          ? {
              commands: {
                ...commandOptions.commands,
                root: project.commandRoot,
              },
            }
          : {}),
        hostTools: async (request) => [
          ...(await webTools(request)),
          ...(kind === "project" ? await jobTools.readTools(request) : []),
          ...(kind === "project" ? await repositoryTools(request) : []),
          ...(kind === "project" && taskTools
            ? await taskTools.readTools(request)
            : []),
        ],
        ...(kind === "project"
          ? {
              approvalHostTools: taskTools
                ? combineApprovalHostTools([
                    jobTools.approvalTools,
                    // Tasks remember this project's chat that started them.
                    taskTools.approvalToolsFor(project.id),
                  ])
                : jobTools.approvalTools,
            }
          : {}),
        onTurnError: ({ sessionId, error, publicError }) => {
          const detail = describeTurnFailure(error);
          if (!detail) return;
          turnFailures.record(project.id, sessionId, detail);
          log(
            `Turn failed in project "${project.id}" (${publicError.code}): ${detail}`,
          );
        },
        files: {
          enabled: true,
          // Protected paths always ask, whatever this says.
          approvalPolicy: {
            hasSessionGrant: (_proposal, request) => autonomous(request),
          },
          ...(config.ripgrepPath
            ? { ripgrepExecutable: config.ripgrepPath }
            : {}),
        },
        // Children are one level deep, use the parent's model unless a role
        // (for example `review`) is requested, and ask for approval when the
        // parent would: an autonomous chat's children run commands and write
        // inside their scopes without asking.
        background: {
          enabled: true,
          inheritSessionGrants: true,
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
      return host;
    };
    for (const project of catalog.list()) {
      if (project.origin === "config") {
        await openHost(project);
        continue;
      }
      // A created project whose folder went missing is skipped, not fatal.
      await openHost(project).catch((error: unknown) => {
        log(`Skipping project "${project.id}": ${message(error)}`);
      });
    }
    const mountFor = (id: string, host: WorkspaceHost) => ({
      projectId: id,
      // Read on each request, so a rename in the app applies at once.
      get label() {
        return catalog.get(id)?.label;
      },
      host,
    });

    // Routes are created first so the server can stop them on close; the
    // owner mapping needs the store, which exists once the server does.
    let authorizeProject: AuthorizeAssistantProject = () => false;
    const routes = createAssistantWorkspaceRoutes({
      projects: hosts.map(({ id, host }) => mountFor(id, host)),
      authorizeProject: (request) => authorizeProject(request),
      models: {
        available: configuredModels(config),
        defaultModel: config.defaultModel,
        ...(config.modelRoles ? { roles: config.modelRoles } : {}),
      },
      eventLog,
      approvalModes,
    });
    agentNotifier = routes;
    const resolveModel = (key: string) => {
      const model = configuredModels(config).find(
        (choice) => modelKey(choice) === key,
      );
      return model
        ? { providerId: model.providerId, modelId: model.modelId }
        : undefined;
    };
    /** A project's defaults for new chats, including scheduled runs. */
    const projectDefaults = (projectId: string) => {
      const settings = catalog.get(projectId)?.settings;
      const model = settings?.defaultModel
        ? resolveModel(settings.defaultModel)
        : undefined;
      return {
        ...(model ? { model } : {}),
        ...(settings?.defaultReasoningEffort
          ? { reasoningEffort: settings.defaultReasoningEffort }
          : {}),
      };
    };
    /**
     * Stop the task or scheduled run working in a chat: a task is recorded
     * as stopped (it can be resumed), a run as cancelled. False when neither
     * works there.
     */
    const stopTaskOrRun = async (workspaceSessionId: string) => {
      const task = taskStore
        .list()
        .find(
          (candidate) =>
            candidate.sessionId === workspaceSessionId &&
            isActiveTask(candidate),
        );
      if (task && taskRunner) {
        await taskRunner.stop(task.id);
        return true;
      }
      const job = jobStore
        .list()
        .find((candidate) =>
          jobStore
            .runs(candidate.id)
            .some(
              (run) => isActiveRun(run) && run.sessionId === workspaceSessionId,
            ),
        );
      if (job) {
        await jobs.stopJob(job.id, "cancelled");
        return true;
      }
      return false;
    };
    // Each project has its own chats; the HTTP API serves them all.
    const legacyChatProject = config.projects[0]?.id;
    const openBridge = (projectId: string) =>
      createAskAgentBridge({
        projectId,
        operations: routes.operations,
        events: routes.events,
        models: {
          available: configuredModels(config),
          defaultModel: config.defaultModel,
        },
        defaults: () => projectDefaults(projectId),
        stateFile: serverAskAgentStateFile(
          config,
          projectId === legacyChatProject ? undefined : projectId,
        ),
        assistantStatus: () => ({
          inboxUnread: inbox.unreadCount(),
          revision: assistantRevision,
        }),
        // Stop in a run's chat stops the run, recorded as cancelled; in a
        // task's chat, it stops the task (which can be resumed).
        stopRun: async (workspaceSessionId) => {
          await stopTaskOrRun(workspaceSessionId);
        },
        chatTasks: (workspaceSessionId) =>
          chatTaskCards(taskStore.list(), projectId, workspaceSessionId),
        // Written in a task's own chat: its runner reads it in its next
        // step, or continues the task with it once it has stopped.
        linkedMessage: async (workspaceSessionId, text) => {
          const task = taskStore
            .list()
            .find((candidate) => candidate.sessionId === workspaceSessionId);
          if (!task || !taskRunner) {
            throw new HttpError(409, "ask_agent_turn_in_progress");
          }
          await taskRunner.steer(task.id, text);
        },
      });
    for (const { id } of hosts) {
      const opened = await openBridge(id);
      bridges.set(id, opened);
    }
    // git where commands run, for project clones and task workspaces.
    const gitOptions: GitCommandOptions = {
      launcher: worker
        ? createCommandWorkerLauncher(worker)
        : createLocalWorkspaceExecutionBackend(),
      gitExecutable: GIT_EXECUTABLE,
      // The owner typed these URLs: clones may reach any public host.
      environment: commandWorkerEnvironment(
        config.commandWorker?.egressProxy
          ? egressProxyUrl(
              config.commandWorker.egressProxy,
              policyKey,
              DEFAULT_NETWORK_POLICY,
            )
          : undefined,
      ),
      ownerId,
    };
    const chat = createProjectChats({
      catalog,
      bridges,
      models: configuredModels(config),
      log,
      ...(config.projectsRoot ? { clone: createGitCloner(gitOptions) } : {}),
      openProject: async (entry) => {
        const host = await openHost(entry);
        routes.addProject(mountFor(entry.id, host));
        const bridge = await openBridge(entry.id);
        bridges.set(entry.id, bridge);
        return bridge;
      },
    });
    /** Add an inbox entry and notify about it; never throws. */
    const addToInbox = async (entry: NewInboxEntry | undefined) => {
      const added = entry ? await inbox.add(entry, Date.now()) : undefined;
      // Best effort, never awaited: the inbox entry is the record.
      if (added) {
        push
          .notifyAll(
            pushMessageForEntry(added, {
              includeSummary: config.notifications?.includeSummary === true,
            }),
          )
          .catch((error: unknown) => {
            log(`Push: could not send a notification: ${message(error)}`);
          });
      }
    };
    // The runaway guard: tells the owner when a chat or task has worked a
    // long time or looks stuck. Notices only; it never stops anything.
    const sessionWatch = createSessionWatch({
      onAlert: (alert) => {
        const task = taskStore
          .list()
          .find(
            (candidate) =>
              candidate.projectId === alert.projectId &&
              candidate.sessionId === alert.sessionId,
          );
        const name = task?.objective
          .split("\n")
          .map((line) => line.trim())
          .find(Boolean);
        addToInbox(inboxEntryForSessionAlert(alert, name))
          .then(() => assistantChanged())
          .catch((error: unknown) => {
            log(`Could not update the inbox: ${message(error)}`);
          });
      },
    });
    const stopWatching = routes.events.observe((key, { event }) => {
      const session = parseSessionKey(key);
      if (session) {
        sessionWatch.observe(session.projectId, session.sessionId, event);
      }
    });
    const watchTimer = setInterval(() => sessionWatch.tick(), 60_000);
    watchTimer.unref();
    /** Raise or settle the inbox entry a run's new record calls for. */
    const recordInInbox = (run: JobRun, job: JobDefinition) => {
      void (async () => {
        // Answered: the reminder to approve is done with.
        if (run.status === "running") {
          await inbox.markRunRead(run.runId, "needs_approval");
        }
        await addToInbox(inboxEntryForRun(run, job));
      })()
        .catch((error: unknown) => {
          log(`Could not update the inbox: ${message(error)}`);
        })
        .finally(assistantChanged);
    };
    /**
     * Raise or settle the inbox entry a task's new record calls for. A task
     * working again (resumed, or its approval answered) settles its earlier
     * entries; the next outcome raises a new one.
     */
    let taskInboxWrites: Promise<void> = Promise.resolve();
    const recordTaskInInbox = (task: TaskRun) => {
      // In order: a quick ready then publishing must not race.
      taskInboxWrites = taskInboxWrites
        .then(async () => {
          if (isActiveTask(task) && task.state !== "awaiting_approval") {
            await inbox.markTaskRead(task.id);
            return;
          }
          await addToInbox(inboxEntryForTask(task));
        })
        .catch((error: unknown) => {
          log(`Could not update the inbox: ${message(error)}`);
        })
        .finally(assistantChanged);
    };
    /**
     * The owner, acting for the server to deliver a task's outcome into its
     * chat: valid while the same owner holds the server.
     */
    const ownerDeliveryAuth = (): AssistantServerAuth | undefined => {
      const ownerId = server?.store.ownerId;
      if (!ownerId) return undefined;
      const at = Date.now();
      const auth: AssistantServerAuth = {
        principal: { tenantId: "agentlink-server", subjectId: ownerId },
        session: {
          ownerId,
          sessionId: `task-results-${at}`,
          deviceId: "task-results",
          deviceLabel: "Task results",
          createdAt: at,
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
        // Never aborted: the delivery turn ends with the turn itself.
        signal: new AbortController().signal,
        async revalidate() {
          return { valid: server?.store.ownerId === ownerId };
        },
        detach: () => auth,
      };
      return auth;
    };
    /** Whether each task was working when last seen, to follow or adopt its chat. */
    const taskChatActivity = new Map<string, boolean>();
    /**
     * A task's own chat is a chat like any other: listed (tagged as a task)
     * in the chat list it was started from, or the first, live while it
     * works, and written to like the VS Code chat it is.
     */
    const showTaskChat = (task: TaskRun) => {
      const sessionId = task.sessionId;
      if (!sessionId) return;
      const bridge =
        bridges.get(task.origin?.projectId ?? "") ??
        bridges.values().next().value;
      const auth = ownerDeliveryAuth();
      if (!bridge || !auth) return;
      const title = `Task: ${task.objective.split("\n", 1)[0]!.slice(0, 80)}`;
      const active = isActiveTask(task);
      const was = taskChatActivity.get(task.id);
      taskChatActivity.set(task.id, active);
      void (async () => {
        await bridge.linkSession(auth, sessionId, {
          projectId: task.projectId,
          title,
        });
        if (active && was !== true) {
          bridge.followSession(auth, sessionId, {
            title,
            prompt: task.objective,
          });
        } else if (!active && was === true) {
          await bridge.adoptSession(auth, sessionId, title);
        }
      })().catch((error: unknown) => {
        log(`Could not show task ${task.id}'s chat: ${message(error)}`);
      });
    };
    /** "Work here": the chat each task is shown in, and its last state. */
    const workShownIn = new Map<
      string,
      { readonly projectId: string; readonly sessionId: string }
    >();
    const workStates = new Map<string, TaskRun["state"]>();
    /**
     * "Work here": while a task works, the chat that asked for it shows the
     * work live and takes the owner's messages for it, with a line for each
     * check and review. Once it stops working, the chat is its own again
     * and the outcome is delivered there like any task's.
     */
    const showWorkHere = (task: TaskRun) => {
      const origin = task.here ? task.origin : undefined;
      const active = isActiveTask(task);
      const shown = workShownIn.get(task.id);
      if (
        shown &&
        (!active ||
          shown.projectId !== origin?.projectId ||
          shown.sessionId !== origin.sessionId)
      ) {
        bridges.get(shown.projectId)?.detachWork(shown.sessionId);
        workShownIn.delete(task.id);
      }
      const previous = workStates.get(task.id);
      if (!origin || !active) {
        workStates.delete(task.id);
        return;
      }
      workStates.set(task.id, task.state);
      const bridge = bridges.get(origin.projectId);
      const auth = ownerDeliveryAuth();
      if (!bridge || !auth || !task.sessionId) return;
      const workspaceSessionId = task.sessionId;
      void (async () => {
        if (!workShownIn.has(task.id)) {
          workShownIn.set(task.id, origin);
          await bridge.attachWork(auth, origin.sessionId, {
            projectId: task.projectId,
            workspaceSessionId,
            title: task.objective.split("\n", 1)[0]!.slice(0, 120),
          });
        }
        const notice = previous !== task.state ? workNotice(task) : undefined;
        if (notice) bridge.noteWork(origin.sessionId, notice);
      })().catch((error: unknown) => {
        log(
          `Could not show task ${task.id}'s work in its chat: ${message(error)}`,
        );
      });
    };
    // A task's outcomes go back to the chat that started it, once each.
    const taskDeliveries = await openTaskDeliveries({
      file: path.join(serverTasksDirectory(config), "deliveries.json"),
      current: (taskId) => taskStore.get(taskId),
      log,
      deliver: async (task) => {
        const origin = task.origin;
        if (!origin) return "chat_missing";
        const bridge = bridges.get(origin.projectId);
        // Its project was removed: so was the chat.
        if (!bridge) return "chat_missing";
        const auth = ownerDeliveryAuth();
        if (!auth) return "unavailable";
        return bridge.deliverTaskResult(auth, origin.sessionId, task);
      },
    });
    // Each run is a new chat in its project, acting for the owner.
    const jobs = createJobRunner({
      store: jobStore,
      operations: routes.operations,
      events: routes.events,
      ownerId: () => server?.store.ownerId,
      resolveModel,
      projectDefaults,
      log,
      failureDetail: (projectId, sessionId) =>
        turnFailures.take(projectId, sessionId),
      onRunRecovered: ({ run, job }) => recordInInbox(run, job),
      onRunChanged: ({ run, job, auth }) => {
        const bridge = bridges.get(run.projectId);
        // Live in its chat while it works; a finished chat once it ends.
        if (bridge && run.sessionId) {
          if (isActiveRun(run)) {
            bridge.followSession(auth, run.sessionId, {
              title: run.title ?? job.name,
              prompt: job.prompt,
            });
          } else {
            void bridge.adoptSession(
              auth,
              run.sessionId,
              run.title ?? "Scheduled run",
            );
          }
        }
        recordInInbox(run, job);
      },
    });
    jobRunner = jobs;

    // Coding tasks: each one is a fresh clone under `<projectsRoot>/.tasks`,
    // mounted as its own hidden project while it exists.
    const taskHosts = new Map<string, WorkspaceHost>();
    // With session runners, each task's session runs in its own container
    // instead of in this process.
    const runnerHosts = new Map<string, RemoteWorkspaceHost>();
    if (config.runners && config.projectsRoot) {
      const runnersConfig = config.runners;
      const runnerManager = createRunnerManagerClient({
        host: runnersConfig.manager.host,
        port: runnersConfig.manager.port,
        readToken: await prepareSecret(
          runnersConfig.manager.token,
          "runners.manager.token",
          env,
        ),
      });
      runnerPool = await startSessionRunnerPool({
        manager: runnerManager,
        backends: providers.map((provider) =>
          createWorkspaceModelBackend(provider),
        ),
        hostTools: (projectId) =>
          projectWebTools(config, {
            policy: () => projectNetworkPolicy(catalog.get(projectId)),
            key: policyKey,
            ...(codex ? { codex: codex.provider } : {}),
          }),
        listen: { host: "0.0.0.0", port: runnersConfig.port },
        controlUrl: `http://${runnersConfig.controlHost}:${runnersConfig.port}`,
        dataRoot: path.join(config.dataRoot, "runners"),
        cacheRoot: path.join(config.dataRoot, "runner-sessions"),
        approvalMode: (projectId, sessionId) =>
          approvalModes.get(projectId, sessionId),
        onAgentApproval: (request) =>
          agentNotifier?.notifyAgentApproval(request),
        onAgentChanged: (change) => agentNotifier?.notifyAgentChange(change),
        onTurnFailure: (projectId, sessionId, detail) => {
          turnFailures.record(projectId, sessionId, detail);
          log(`Turn failed in project "${projectId}": ${detail}`);
        },
        idleMs: runnersConfig.idleMinutes * 60_000,
        log,
      });
    }
    const tasks = config.projectsRoot
      ? await (async () => {
          await fs.mkdir(config.projectsRoot!, { recursive: true });
          const tasksRoot = path.join(
            await fs.realpath(config.projectsRoot!),
            ".tasks",
          );
          const workspaces = createTaskWorkspaces({
            tasksRoot,
            git: createGitCommand(gitOptions),
            // Validation runs where commands run, like the chats' commands.
            run: createProcessRunner(gitOptions),
            shell: config.commandWorker?.shell ?? "/bin/sh",
          });
          const openTaskProject = async (task: TaskRun) => {
            if (taskHosts.has(task.projectId)) return;
            if (runnerHosts.has(task.projectId)) return;
            if (runnerPool) {
              const proxy = config.commandWorker?.egressProxy;
              const host = runnerPool.open(
                {
                  projectId: task.projectId,
                  projectRoot: path.dirname(task.workspace),
                  commandRoot: task.workspace,
                  shell: config.commandWorker?.shell ?? "/bin/bash",
                  defaultModel: config.defaultModel,
                  ...(config.modelRoles
                    ? {
                        modelRoles: Object.fromEntries(
                          Object.entries(config.modelRoles).filter(
                            (entry): entry is [string, AgentModelReference] =>
                              entry[1] !== undefined,
                          ),
                        ),
                      }
                    : {}),
                  instructions: AUTO_CONTINUE_INSTRUCTIONS,
                  // The task's network preset, signed into the proxy URL as
                  // for its commands on the worker.
                  commandEnvironment: commandWorkerEnvironment(
                    proxy
                      ? egressProxyUrl(
                          proxy,
                          policyKey,
                          projectNetworkPolicy(catalog.get(task.projectId)),
                        )
                      : undefined,
                  ),
                },
                path.dirname(task.workspace),
              );
              runnerHosts.set(task.projectId, host);
              routes.addProject({
                projectId: task.projectId,
                label: `Task: ${task.objective.replace(/\s+/gu, " ").slice(0, 60)}`,
                host,
                hidden: true,
              });
              return;
            }
            // The task folder: the clone plus read-only references under
            // refs/. Commands still run only in the clone.
            const host = await openHost(
              {
                id: task.projectId,
                root: path.dirname(task.workspace),
                commandRoot: task.workspace,
              },
              "task",
            );
            taskHosts.set(task.projectId, host);
            routes.addProject({
              projectId: task.projectId,
              label: `Task: ${task.objective.replace(/\s+/gu, " ").slice(0, 60)}`,
              host,
              hidden: true,
            });
          };
          const runner = createTaskRunner({
            store: taskStore,
            workspaces,
            operations: routes.operations,
            events: routes.events,
            projects: {
              open: openTaskProject,
              async close(task) {
                const remote = runnerHosts.get(task.projectId);
                if (remote) {
                  runnerHosts.delete(task.projectId);
                  routes.removeProject(task.projectId);
                  await remote.close();
                  return;
                }
                const host = taskHosts.get(task.projectId);
                if (!host) return;
                taskHosts.delete(task.projectId);
                routes.removeProject(task.projectId);
                const index = hosts.findIndex((entry) => entry.host === host);
                if (index >= 0) hosts.splice(index, 1);
                await host.close();
              },
            },
            ownerId: () => server?.store.ownerId,
            resolveModel,
            defaultModel: config.defaultModel,
            // Reviews go to another provider: Codex work is reviewed by
            // Claude (through Meridian) and the reverse.
            reviewModel: (implementer) =>
              pickReviewModel(implementer, {
                roleModel: config.modelRoles?.review,
                available: configuredModels(config),
              }),
            repositories: repositorySettings,
            connections: githubConnections,
            ...(publisher ? { publisher } : {}),
            // The one connection reaching a repository clones it when the
            // owner chose none; several need the owner to choose.
            reachableConnection: async (repository) => {
              const resolved =
                await repositoryDirectory.resolveConnection(repository);
              return resolved.kind === "one"
                ? resolved.connectionId
                : undefined;
            },
            log,
            failureDetail: (projectId, sessionId) =>
              turnFailures.take(projectId, sessionId),
            onTaskChanged: (task) => {
              assistantChanged();
              recordTaskInInbox(task);
              // Before the outcome is delivered: the chat is its own again.
              showWorkHere(task);
              taskDeliveries.taskChanged(task);
              showTaskChat(task);
            },
          });
          return {
            runner: {
              ...runner,
              async delete(taskId: string) {
                const sessionId = taskStore.get(taskId)?.sessionId;
                await runner.delete(taskId);
                taskDeliveries.forget(taskId);
                taskChatActivity.delete(taskId);
                const shown = workShownIn.get(taskId);
                if (shown) {
                  bridges.get(shown.projectId)?.detachWork(shown.sessionId);
                  workShownIn.delete(taskId);
                }
                workStates.delete(taskId);
                if (sessionId) {
                  for (const bridge of bridges.values()) {
                    await bridge.unlinkSession(sessionId);
                  }
                }
              },
            },
            workspaces,
            openTaskProject,
          };
        })()
      : undefined;
    taskRunner = tasks?.runner;
    const taskRoutes = createTaskRoutes({
      store: taskStore,
      repositories: repositorySettings,
      connections: githubConnections,
      runner: tasks?.runner,
      isOwner: (auth) =>
        server !== undefined &&
        auth.principal.subjectId === server.store.ownerId,
      models: configuredModels(config),
    });
    const jobRoutes = createJobRoutes({
      store: jobStore,
      runner: jobs,
      isOwner: (auth) =>
        server !== undefined &&
        auth.principal.subjectId === server.store.ownerId,
      hasProject: (projectId) => bridges.has(projectId),
      models: configuredModels(config),
      defaultTimeZone: serverTimeZone(),
    });
    const inboxRoutes = createInboxRoutes({
      store: inbox,
      isOwner: (auth) =>
        server !== undefined &&
        auth.principal.subjectId === server.store.ownerId,
      onChanged: assistantChanged,
      // Stop or Keep going on a "still working" or "may be stuck" notice.
      act: async (entry, action, auth) => {
        if (!entry.sessionId) return;
        if (action === "keep_going") {
          sessionWatch.keepGoing(entry.projectId, entry.sessionId);
          return;
        }
        if (await stopTaskOrRun(entry.sessionId)) return;
        const bridge = bridges.get(entry.projectId);
        if (bridge) {
          await bridge.stop(auth.detach(), entry.sessionId);
          return;
        }
        await routes.operations
          .cancel(auth, entry.projectId, entry.sessionId)
          .catch(() => undefined);
      },
    });
    const pushRoutes = createPushRoutes({
      push,
      isOwner: (auth) =>
        server !== undefined &&
        auth.principal.subjectId === server.store.ownerId,
    });
    const githubRoutes = createGitHubRoutes({
      connections: githubConnections,
      publisher,
      repositories: repositorySettings,
      directory: repositoryDirectory,
      isOwner: (auth) =>
        server !== undefined &&
        auth.principal.subjectId === server.store.ownerId,
    });
    const assetVersion = randomUUID();
    server = await createAssistantServer({
      dataRoot: serverAccessDataRoot(config),
      tls,
      publicOrigins: config.publicOrigins,
      listen: config.listen,
      handleRequest: async (request, response, auth) =>
        (await chat.handleRequest(request, response, auth)) ||
        (await jobRoutes.handleRequest(request, response, auth)) ||
        (await taskRoutes.handleRequest(request, response, auth)) ||
        (await inboxRoutes.handleRequest(request, response, auth)) ||
        (await pushRoutes.handleRequest(request, response, auth)) ||
        (await githubRoutes.handleRequest(request, response, auth)) ||
        (await routes.handleRequest(request, response, auth)),
      deviceNotifications: {
        isOn: (deviceId) => push.isSubscribed(deviceId),
        turnOff: async (deviceId) => {
          await push.unsubscribe(deviceId);
        },
      },
      onClose: async () => {
        // Before the routes stop turns: open runs are recorded interrupted.
        if (snapshotSweep) clearInterval(snapshotSweep);
        await jobs.close();
        await tasks?.runner.close();
        await taskDeliveries.flush();
        await taskStore.flush();
        await taskInboxWrites;
        clearInterval(watchTimer);
        stopWatching();
        await inbox.flush();
        await push.close();
        await chat.close();
        await routes.close();
      },
      webAssets: bundledWebAssets(),
      ...(bridges.size > 0
        ? {
            renderAppPage: ({ nonce }: { readonly nonce: string }) =>
              renderBrowserGatewayIndexHtml({
                assetVersion,
                applicationName: "AgentLink Assistant",
                title: "AgentLink Assistant",
                shortName: "Assistant",
                themeColor: "#B59AFF",
                nonce,
                config: {
                  currentInstanceId: "",
                  // The app asks for the selected project once signed in.
                  workspaceName: "",
                  routeByInstance: false,
                  askAgentOnly: true,
                  product: "assistant",
                  initialTheme: chat.theme,
                  dataPlaneMode: "off",
                },
              }),
          }
        : {}),
    });
    authorizeProject = ownerProjectAccess(server.store);
    // Revoking a device turns its notifications off, now and at startup.
    const retainSignedInDevices = () => {
      const active = activeDeviceIds();
      if (!active) return;
      push.retainDevices(active).catch((error: unknown) => {
        log(`Push: could not update subscriptions: ${message(error)}`);
      });
    };
    server.store.onSessionsRevoked(retainSignedInDevices);
    retainSignedInDevices();
    const { port } = await server.start();
    certificates?.watch(server);
    await jobs.start();
    if (tasks) {
      await tasks.runner.start();
      // Earlier tasks' chats stay readable: mount each clone still on disk.
      for (const task of taskStore.list()) {
        if (!(await tasks.workspaces.exists(task))) continue;
        await tasks.openTaskProject(task).catch((error: unknown) => {
          log(`Could not open task ${task.id}'s clone: ${message(error)}`);
        });
        showTaskChat(task);
      }
      // Outcomes reached while the server was down, not yet delivered.
      taskDeliveries.start(taskStore.list());
    }
    log(
      `AgentLink server listening on ${config.listen.host}:${port} for ${config.publicOrigins.join(", ")} (${hosts.length} project${hosts.length === 1 ? "" : "s"})`,
    );
    if (!server.store.hasActiveDevices) {
      log(
        "No devices are paired yet. On this machine run `agentlink-server pair` to get a sign-in code.",
      );
    }
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
          await runnerPool?.close();
          // Last: stopping turns and children publishes their final events.
          routes.events.close();
          await eventLog.close();
          await certificates?.stop();
        })();
        return closing;
      },
    };
  } catch (error) {
    recovery.stop();
    await server?.close().catch(() => undefined);
    if (!server) {
      for (const opened of bridges.values()) {
        await opened.close().catch(() => undefined);
      }
    }
    await recovery.settled();
    await closeHosts();
    await runnerPool?.close().catch(() => undefined);
    await eventLog.close();
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
