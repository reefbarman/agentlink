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
  serverCredentialsDirectory,
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
import {
  createRunnerManagerClient,
  type RunnerManagerClient,
} from "./runnerManager.js";
import { createTaskEditors, type TaskEditors } from "./taskEditors.js";
import {
  createBrowseTools,
  createBrowserPool,
  type BrowserPool,
} from "./browserResearch.js";
import { connectCdp } from "./cdpClient.js";
import { startEditorProxy, type EditorProxy } from "./editorProxy.js";
import {
  editorAgentLinkSettings,
  startEditorModelServer,
  type EditorModelServer,
} from "./editorModels.js";
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
  type AssistantServerModelChoice,
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
  describeQuietHours,
  openPersonaStore,
  personaInstructions,
} from "./persona.js";
import { createPersonaRoutes } from "./personaRoutes.js";
import { onboardingFeatures, openOnboardingStore } from "./onboarding.js";
import { liveModelReference } from "./liveModels.js";
import {
  MANAGED_OPENAI_PROVIDER_ID,
  managedOpenAiProviderConfig,
  openAiExternallyManaged,
  openManagedProviders,
} from "./managedProviders.js";
import { createOnboardingRoutes } from "./onboardingRoutes.js";
import { createProviderRoutes } from "./providerRoutes.js";
import { createManagedProviderRoutes } from "./managedProviderRoutes.js";
import { createStorageRoutes, measureStorage } from "./storageRoutes.js";
import { removeTaskData } from "./taskDataDeletion.js";
import { openAssistantMemory } from "./assistantMemory.js";
import { createMemoryRoutes } from "./memoryRoutes.js";
import { createPersonaTools } from "./personaTools.js";
import { createQuietPush } from "./quietPush.js";
import { openPushLog } from "./pushLog.js";
import {
  inboxEntryForBackupProblem,
  inboxEntryForChat,
  inboxEntryForCheckpointProblem,
  inboxEntryForInterruptedChat,
  inboxEntryForMcpChange,
  inboxEntryForRestore,
  inboxEntryForRun,
  inboxEntryForSessionAlert,
  inboxEntryForTask,
  inboxEntryForUnusualUsage,
  inboxEntryForWatchNoise,
  openInboxStore,
  type NewInboxEntry,
} from "./inboxStore.js";
import { unusualUsage } from "./jobUsage.js";
import { briefingOpenItems, createBriefings } from "./briefings.js";
import { personalConnection } from "./personalConnections.js";
import { createWatcher, type Watcher } from "./watches.js";
import { openWatchStore } from "./watchStore.js";
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
import {
  directConnector,
  fetchWebPage,
  gatewayConnector,
  type WebConnector,
} from "./webFetch.js";
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
import { writeFileAtomic } from "./atomicFile.js";
import { takeRestoredMarker } from "./backup.js";
import type { BackupStatus } from "./backupAgent.js";
import { backupProblem, createBackupClient } from "./backupClient.js";
import { createBackupRoutes } from "./backupRoutes.js";
import { createUpdaterClient } from "./updaterClient.js";
import { createUpdateRoutes } from "./updateRoutes.js";
import { createAssistantMcpTools } from "./assistantMcpTools.js";
import { openMcpRegistry } from "./mcpRegistry.js";
import { MCP_OAUTH_RETURN_PATH, createMcpRoutes } from "./mcpRoutes.js";
import {
  TASK_PROJECT_PREFIX,
  createTaskRunner,
  type TaskRunner,
} from "./taskRunner.js";
import { prepareDataVersion } from "./dataVersion.js";
import { createMaintenance, type Maintenance } from "./maintenance.js";
import { SERVER_BUILD, describeBuild, versionProblems } from "./serverBuild.js";
import { serviceVersions } from "./serviceVersions.js";
import {
  auditedTaskStore,
  openTaskAudit,
  readAuditHashes,
  type TaskAuditActor,
} from "./taskAudit.js";
import {
  checkpointKeyFile,
  loadCheckpointKey,
  startAuditCheckpointer,
  type AuditCheckpointer,
} from "./auditCheckpoint.js";
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

/** The Assistant's persona, time zone and quiet hours. */
export function serverPersonaFile(config: AssistantServerConfig): string {
  return path.join(config.dataRoot, "settings", "persona.json");
}

/** First-run setup progress (written first by the guided installer). */
export function serverOnboardingFile(config: AssistantServerConfig): string {
  return path.join(config.dataRoot, "settings", "onboarding.json");
}

/**
 * Model providers set up in the browser. The guided installer creates it,
 * which is the opt-in; without it only `server.json` configures providers.
 */
export function serverModelProvidersFile(
  config: AssistantServerConfig,
): string {
  return path.join(config.dataRoot, "settings", "model-providers.json");
}

/** Per-session approval modes (which sessions ask for everything). */
export function serverMemoryDirectory(config: AssistantServerConfig): string {
  return path.join(config.dataRoot, "memory");
}

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

/** What each watch has seen: snapshots, validators, relevant changes. */
export function serverWatchesDirectory(config: AssistantServerConfig): string {
  return path.join(config.dataRoot, "watches");
}

/** The owner's inbox of job results and approvals waiting. */
export function serverInboxDirectory(config: AssistantServerConfig): string {
  return path.join(config.dataRoot, "inbox");
}

/** The coding tasks' hash-chained audit log; only the server writes it. */
export function serverAuditDirectory(config: AssistantServerConfig): string {
  return path.join(config.dataRoot, "audit");
}

/** What the audit checkpointer last did (beside the log it checkpoints). */
export function serverCheckpointStateFile(
  config: AssistantServerConfig,
): string {
  return path.join(config.dataRoot, "audit", "checkpoints.json");
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
  /** Present when a backup sidecar is configured. */
  readonly backup?: string;
  readonly updater?: string;
  /** The persona settings, read-only. */
  readonly persona?: string;
  /** How many memories there are. */
  readonly memory?: string;
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
  const key = options.key;
  const codex = options.codex;
  const codexProviderIds = new Set(
    config.providers
      .filter((provider) => provider.type === "codex")
      .map((provider) => provider.id ?? "codex"),
  );
  return createWebTools({
    policy: options.policy,
    connector: serverWebConnector(config, key),
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

/**
 * How the server reads web pages: through the egress gateway with a
 * project's signed policy when there is one, otherwise directly with the
 * same checks.
 */
export function serverWebConnector(
  config: Pick<AssistantServerConfig, "commandWorker">,
  key: Buffer | undefined,
): WebConnector {
  const proxy = config.commandWorker?.egressProxy;
  return proxy
    ? gatewayConnector({
        proxy,
        authorization: (policy) =>
          key ? proxyAuthorizationHeader(key, policy) : undefined,
      })
    : directConnector();
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
  if (config.backup) {
    const { host, port } = config.backup;
    const client = createBackupClient({
      host,
      port,
      token: await prepareSecret(config.backup.token, "backup.token", env),
    });
    let backupStatus: string;
    try {
      const status = await client.status();
      const at = Date.now();
      const problem = backupProblem(status, at, at);
      backupStatus = status.runningSince
        ? `Backups: reachable at ${host}:${port}; a backup is running`
        : problem?.kind === "failed"
          ? `Backups: reachable at ${host}:${port}; the last backup failed: ${problem.error}`
          : status.lastSuccess
            ? `Backups: reachable at ${host}:${port}; last good backup ${status.lastSuccess.snapshotId.slice(0, 8)} at ${new Date(status.lastSuccess.at).toISOString()}`
            : `Backups: reachable at ${host}:${port}; no backup yet`;
    } catch (error) {
      backupStatus = `Backups: not reachable at ${host}:${port} (${error instanceof Error ? error.message : String(error)})`;
    }
    result = { ...result, backup: backupStatus };
  }
  if (config.updater) {
    const client = createUpdaterClient({
      host: config.updater.host,
      port: config.updater.port,
      token: await prepareSecret(config.updater.token, "updater.token", env),
    });
    try {
      const status = await client.status();
      result = {
        ...result,
        updater: status.managed
          ? `Updates: managed release ${status.installedVersion ?? "unknown"}`
          : "Updates: source/legacy deployment; browser updates disabled",
      };
    } catch {
      result = {
        ...result,
        updater:
          "Updates: supervisor unavailable; existing Assistant work is unaffected",
      };
    }
  }
  // Read-only: an unreadable persona file stops the server, so report it.
  const persona = (
    await openPersonaStore({
      file: serverPersonaFile(config),
      defaultTimeZone: serverTimeZone(),
    })
  ).get();
  result = {
    ...result,
    persona: `Persona: ${persona.name}${persona.updatedAt === 0 ? " (defaults)" : ""}; time zone ${persona.timeZone}; quiet hours ${describeQuietHours(persona.quietHours)}`,
  };
  // Read-only too: an unreadable memory store stops the server.
  const remembered = (
    await openAssistantMemory({ directory: serverMemoryDirectory(config) })
  ).count();
  result = {
    ...result,
    memory: `Memory: ${remembered} ${remembered === 1 ? "memory" : "memories"} about you`,
  };
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
  watch(server: Pick<AssistantServer, "setTls">): void;
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
  // Before anything opens a store: migrate older data, refuse newer.
  const dataVersion = await prepareDataVersion({
    dataRoot: config.dataRoot,
    log,
  });
  log(
    `AgentLink server ${describeBuild(SERVER_BUILD)}, data format ${dataVersion.to}${dataVersion.from === dataVersion.to ? "" : ` (migrated from ${dataVersion.from})`}`,
  );
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
  // What each watch has seen; a watch deleted while down loses its file.
  const watchStore = await openWatchStore({
    directory: serverWatchesDirectory(config),
  }).catch(async (error: unknown) => {
    await eventLog.close();
    await certificates?.stop();
    throw error;
  });
  await watchStore
    .prune(
      new Set(
        jobStore
          .list()
          .filter((job) => job.watch)
          .map((job) => job.id),
      ),
    )
    .catch((error: unknown) => {
      log(`Could not tidy watch snapshots: ${message(error)}`);
    });
  const inbox = await openInboxStore({
    directory: serverInboxDirectory(config),
  }).catch(async (error: unknown) => {
    await eventLog.close();
    await certificates?.stop();
    throw error;
  });
  // The Assistant's name and voice, the owner's time zone, quiet hours.
  const persona = await openPersonaStore({
    file: serverPersonaFile(config),
    defaultTimeZone: serverTimeZone(),
  }).catch(async (error: unknown) => {
    await eventLog.close();
    await certificates?.stop();
    throw error;
  });
  // First-run setup progress; an unreadable file stops the server.
  const onboarding = await openOnboardingStore({
    file: serverOnboardingFile(config),
  }).catch(async (error: unknown) => {
    await eventLog.close();
    await certificates?.stop();
    throw error;
  });
  // The OpenAI API key and default model chosen in the browser. A missing
  // or unusable key is reported, never fatal: management and recovery
  // start without one.
  const configuredChoices = configuredModels(config);
  const managedOpenAi = managedOpenAiProviderConfig(
    serverCredentialsDirectory(config),
  );
  const externallyManaged = openAiExternallyManaged(config.providers);
  const managedChoices = externallyManaged
    ? []
    : configuredModels({ providers: [managedOpenAi] });
  const sameModel =
    (model: AgentModelReference) =>
    (choice: AgentModelReference): boolean =>
      choice.providerId === model.providerId &&
      choice.modelId === model.modelId;
  const managedProviders = await openManagedProviders({
    settingsFile: serverModelProvidersFile(config),
    credentialsDirectory: serverCredentialsDirectory(config),
    externallyManaged,
    isKnownModel: (model) =>
      configuredChoices.some(sameModel(model)) ||
      managedChoices.some(sameModel(model)),
    log,
  }).catch(async (error: unknown) => {
    await eventLog.close();
    await certificates?.stop();
    throw error;
  });
  if (managedProviders.offered) {
    // Always registered, so a key saved later works without a restart:
    // the key is read on every request, and a request without one fails.
    providers.push({
      type: "openai",
      id: MANAGED_OPENAI_PROVIDER_ID,
      ...(managedOpenAi.displayName
        ? { displayName: managedOpenAi.displayName }
        : {}),
      modelIds: managedChoices.map((choice) => choice.modelId),
      resolveApiKey: () => managedProviders.resolveOpenAiKey(),
    });
  }
  /**
   * The models chats, tasks, jobs and editors may use right now: the
   * configured ones plus OpenAI's once a key is saved. A chosen OpenAI
   * default stays listed without a key, so new chats on it fail clearly
   * instead of quietly using another provider.
   */
  const availableModels = (): AssistantServerModelChoice[] => {
    const choices = [...configuredChoices];
    if (!managedProviders.offered) return choices;
    if (managedProviders.hasOpenAiKey()) return [...choices, ...managedChoices];
    const chosen = managedProviders.selectedDefault();
    const kept = chosen ? managedChoices.find(sameModel(chosen)) : undefined;
    return kept ? [...choices, kept] : choices;
  };
  /** The owner's choice from Setup, otherwise `server.json`'s. */
  const currentDefaultModel = (): AgentModelReference =>
    managedProviders.selectedDefault() ?? config.defaultModel;
  /** The persona block for a chat, read each turn. */
  const personaBlock = (kind: "owner" | "task") =>
    personaInstructions(persona.get(), kind, Date.now());
  // What the Assistant remembers about the owner, from their own words.
  const memory = await openAssistantMemory({
    directory: serverMemoryDirectory(config),
    // Chats' Remembered lines and the Memory panel follow it.
    onChanged: () => assistantChanged(),
  }).catch(async (error: unknown) => {
    await eventLog.close();
    await certificates?.stop();
    throw error;
  });
  // Started once backups are known (checkpoints go to the backup store).
  let checkpointer: AuditCheckpointer | undefined;
  // Opened before the tasks, so every change to them is on record.
  const taskAudit = await openTaskAudit({
    directory: serverAuditDirectory(config),
    log,
    // A push, pull request or MCP call is checkpointed straight away.
    onWritten: (kinds) => {
      if (kinds.includes("effect") || kinds.includes("mcp_call")) {
        checkpointer?.effectRecorded();
      }
    },
  }).catch(async (error: unknown) => {
    await eventLog.close();
    await certificates?.stop();
    throw error;
  });
  const taskStore = auditedTaskStore(
    await openTaskStore({
      directory: serverTasksDirectory(config),
    }).catch(async (error: unknown) => {
      await eventLog.close();
      await certificates?.stop();
      throw error;
    }),
    taskAudit,
    {
      // Task chats run in session runners when they are configured.
      runsIn: () =>
        config.runners && config.projectsRoot ? "runner" : "server",
    },
  );
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
  const updaterClient = config.updater
    ? createUpdaterClient({
        host: config.updater.host,
        port: config.updater.port,
        token: await prepareSecret(config.updater.token, "updater.token", env),
      })
    : undefined;
  const backupClient = config.backup
    ? createBackupClient({
        host: config.backup.host,
        port: config.backup.port,
        token: await prepareSecret(config.backup.token, "backup.token", env),
      })
    : undefined;
  // The owner's remote MCP servers; only this process ever calls them.
  const mcpRegistry = await openMcpRegistry({
    dataRoot: config.dataRoot,
    redirectUrl: new URL(MCP_OAUTH_RETURN_PATH, config.publicOrigins[0]!).href,
  }).catch(async (error: unknown) => {
    await eventLog.close();
    await certificates?.stop();
    throw error;
  });
  // Bound to the inbox once it is ready (before any server is refreshed).
  let mcpInbox: (entry: NewInboxEntry) => Promise<unknown> = async () =>
    undefined;
  // Bound to the inbox once it is ready (chats cannot run before then).
  let chatInbox: (entry: NewInboxEntry) => void = () => undefined;
  /** Test a server, and tell the owner when tools changed (they ask again). */
  const refreshMcpServer = async (serverId: string) => {
    const result = await mcpRegistry.refresh(serverId);
    if (result.changed.length > 0) {
      await mcpInbox(
        inboxEntryForMcpChange(
          result.server,
          result.changed,
          config.projects[0]?.id ?? "home",
        ),
      );
    }
    assistantChanged();
    return result;
  };
  const mcpToolsFor = (
    projectId: string,
    scope: { readonly network: boolean },
  ) =>
    createAssistantMcpTools({
      registry: mcpRegistry,
      projectId,
      network: scope.network,
      audit: async (record) => {
        const { projectId: _projectId, ...data } = record;
        await taskAudit
          .mcpCall(
            projectId.startsWith(TASK_PROJECT_PREFIX)
              ? projectId.slice(TASK_PROJECT_PREFIX.length)
              : "",
            { ...data, projectId },
            Date.now(),
          )
          .catch(() => undefined);
      },
      onProposed: (serverId) => {
        void refreshMcpServer(serverId).catch((error: unknown) => {
          log(`Could not test MCP server "${serverId}": ${message(error)}`);
        });
      },
    });
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
  // How often the owner was pinged, for usage reports (counts only).
  const pushLog = await openPushLog({
    directory: serverPushDirectory(config),
  });
  // Pushes wait out the owner's quiet hours; Inbox entries never do.
  const quietPush = createQuietPush({
    settings: () => persona.get(),
    isUnread: (entryId) =>
      inbox.list().some((entry) => entry.id === entryId && !entry.read),
    send: (notification) => {
      push
        .notifyAll(notification)
        .then((deliveries) => pushLog.record(deliveries))
        .catch((error: unknown) => {
          log(`Push: could not send a notification: ${message(error)}`);
        });
    },
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
    // Draining for an upgrade: bound before the server starts listening.
    let maintenance: Maintenance | undefined;
    const workPaused = () => maintenance?.paused() ?? false;
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
          models: availableModels,
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
    /** Research browsers, once the runner manager is known (below). */
    let browserPool: BrowserPool | undefined;
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
        models: availableModels,
        // The owner's, as set in Settings.
        get defaultTimeZone() {
          return persona.get().timeZone;
        },
        onChanged: () => assistantChanged(),
      });
      // Servers on the owner's network are for the owner's chats only.
      const mcpTools = mcpToolsFor(project.id, { network: kind === "project" });
      // Chats can propose persona changes; the owner approves each one.
      const personaTools = createPersonaTools({
        store: persona,
        onChanged: () => {
          quietPush.reschedule();
          assistantChanged();
        },
      });
      const host = await createWorkspaceHost({
        projectRoot: project.root,
        dataRoot: path.join(config.dataRoot, "workspace"),
        // By project ID, not by folder: chats survive a restore or a move.
        storageKey: project.id,
        ownerId,
        providers,
        // Live: copied into the engine once, but read on every turn, so a
        // default chosen in Setup applies to chats without their own model.
        defaultModel: liveModelReference(currentDefaultModel),
        promptIdentity: { role: "a personal assistant" },
        // VS Code's guidance for the tools each chat has (no ask_user and no
        // modes here). Owner chats are a general assistant; a coding task's
        // chat keeps the coding-assistant rule.
        sharedPromptGuidance:
          kind === "project" ? { codingAssistant: false } : true,
        turnLimits: SESSION_TURN_LIMITS,
        // The todo list, for Auto Continue, and VS Code's set_task_status
        // (a final card that ends Auto Continue); no ask_user (approval
        // cards and messages are how a chat reaches the owner).
        sessionInteractions: { finalStatus: true },
        // The project's AGENTS.md, rules and skills, as VS Code reads them.
        // Never the server's home folder: the persona and memory stand in
        // for the owner's global instructions.
        agentInstructions: { enabled: true, homeDir: null },
        // VS Code's search_session_history and read_session_excerpt.
        sessionRecall: { enabled: true },
        condense: { enabled: true },
        // Read each turn, so a persona change applies without a restart.
        instructions: async (request) =>
          kind === "project"
            ? `${personaBlock("owner")}\n\n${await memory.instructionsFor(request)}\n\n${routingInstructions}\n\n${AUTO_CONTINUE_INSTRUCTIONS}`
            : `${personaBlock("task")}\n\n${AUTO_CONTINUE_INSTRUCTIONS}`,
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
          // A throwaway browser, on Open web owner projects.
          ...(kind === "project" && browserPool
            ? await createBrowseTools({
                pool: browserPool,
                projectId: project.id,
                policy: () => projectNetworkPolicy(catalog.get(project.id)),
              })(request)
            : []),
          ...(await mcpTools.readTools(request)),
          ...(kind === "project" ? await jobTools.readTools(request) : []),
          ...(kind === "project" ? await repositoryTools(request) : []),
          ...(kind === "project"
            ? memory.tools({
                projectId: project.id,
                sessionId: request.sessionId,
              })
            : []),
          ...(kind === "project" && taskTools
            ? await taskTools.readTools(request)
            : []),
        ],
        approvalHostTools:
          kind === "project"
            ? combineApprovalHostTools([
                jobTools.approvalTools,
                personaTools,
                // Tasks remember this project's chat that started them.
                ...(taskTools ? [taskTools.approvalToolsFor(project.id)] : []),
                mcpTools.approvalTools,
              ])
            : mcpTools.approvalTools,
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
        get available() {
          return availableModels();
        },
        get defaultModel() {
          return currentDefaultModel();
        },
        ...(config.modelRoles ? { roles: config.modelRoles } : {}),
      },
      eventLog,
      approvalModes,
      // Task chats keep going while draining: their runner admits work.
      turnsPaused: (projectId) =>
        workPaused() && !projectId.startsWith(TASK_PROJECT_PREFIX),
    });
    agentNotifier = routes;
    const resolveModel = (key: string) => {
      const model = availableModels().find(
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
    const stopTaskOrRun = async (
      workspaceSessionId: string,
      by: TaskAuditActor,
    ) => {
      const task = taskStore
        .list()
        .find(
          (candidate) =>
            candidate.sessionId === workspaceSessionId &&
            isActiveTask(candidate),
        );
      if (task && taskRunner) {
        await taskAudit
          .request(task.id, "stop", by, Date.now())
          .catch(() => undefined);
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
          get available() {
            return availableModels();
          },
          get defaultModel() {
            return currentDefaultModel();
          },
        },
        defaults: () => projectDefaults(projectId),
        stateFile: serverAskAgentStateFile(
          config,
          projectId === legacyChatProject ? undefined : projectId,
        ),
        assistantStatus: () => {
          const state = maintenance?.status().state ?? "running";
          return {
            inboxUnread: inbox.unreadCount(),
            revision: assistantRevision,
            version: describeBuild(SERVER_BUILD),
            ...(state === "running" ? {} : { maintenance: state }),
          };
        },
        workPaused,
        // Stop in a run's chat stops the run, recorded as cancelled; in a
        // task's chat, it stops the task (which can be resumed).
        stopRun: async (workspaceSessionId) => {
          await stopTaskOrRun(workspaceSessionId, {
            kind: "task_chat",
            sessionId: workspaceSessionId,
          });
        },
        chatTasks: (workspaceSessionId) =>
          chatTaskCards(taskStore.list(), projectId, workspaceSessionId),
        chatMemories: (workspaceSessionId) =>
          memory.rememberedIn(projectId, workspaceSessionId),
        chatDeleted: async (workspaceSessionId) => {
          await inbox.remove({ projectId, sessionId: workspaceSessionId });
          assistantChanged();
        },
        // A chat that stops for the owner goes to the Inbox, for its badge
        // and notifications.
        chatNeedsYou: (chat) => {
          chatInbox(
            inboxEntryForChat(
              {
                projectId: chat.projectId,
                sessionId: chat.workspaceSessionId,
                reason: chat.reason,
              },
              chat.title,
            ),
          );
        },
        // Opening a chat reads what the Inbox says about it.
        chatViewed: (chat) => {
          void inbox
            .markSessionRead({
              projectId: chat.projectId,
              sessionId: chat.workspaceSessionId,
            })
            .then((marked) => {
              if (marked > 0) assistantChanged();
            })
            .catch(() => undefined);
        },
        // Written in a task's own chat: its runner reads it in its next
        // step, or continues the task with it once it has stopped.
        linkedMessage: async (workspaceSessionId, text) => {
          const task = taskStore
            .list()
            .find((candidate) => candidate.sessionId === workspaceSessionId);
          if (!task || !taskRunner) {
            throw new HttpError(409, "ask_agent_turn_in_progress");
          }
          await taskAudit
            .request(
              task.id,
              "message",
              { kind: "task_chat", sessionId: workspaceSessionId },
              Date.now(),
              { text },
            )
            .catch(() => undefined);
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
      models: availableModels,
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
    /**
     * Add an inbox entry and notify about it. With `pushAfterMs` the push
     * waits that long and is dropped if the entry was read meanwhile (the
     * owner was looking at the chat).
     */
    const addToInbox = async (
      entry: NewInboxEntry | undefined,
      pushAfterMs?: number,
    ) => {
      const added = entry ? await inbox.add(entry, Date.now()) : undefined;
      // Best effort, never awaited: the inbox entry is the record. Pushes
      // wait out quiet hours.
      if (!added) return;
      const deliver = () =>
        quietPush.deliver(
          added,
          pushMessageForEntry(added, {
            includeSummary: config.notifications?.includeSummary === true,
          }),
        );
      if (pushAfterMs === undefined) {
        deliver();
        return;
      }
      const timer = setTimeout(() => {
        if (inbox.list().some((item) => item.id === added.id && !item.read)) {
          deliver();
        }
      }, pushAfterMs);
      timer.unref();
    };
    mcpInbox = (entry) => addToInbox(entry);
    chatInbox = (entry) => {
      addToInbox(entry, CHAT_PUSH_DELAY_MS)
        .then(() => assistantChanged())
        .catch((error: unknown) => {
          log(`Could not update the inbox: ${message(error)}`);
        });
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
    /**
     * Backups: a failed or overdue backup goes to the Inbox once (the last
     * one reported is remembered across restarts).
     */
    const backupAlertFile = path.join(
      config.dataRoot,
      "settings",
      "backup-alert.json",
    );
    const backupWatchSince = Date.now();
    let backupAlertKey = await fs
      .readFile(backupAlertFile, "utf8")
      .then((raw) => String((JSON.parse(raw) as { key?: unknown }).key ?? ""))
      .catch(() => "");
    let backupChecking = false;
    // The last status seen: a sidecar that stopped answering still
    // becomes "no backup for a day" once its last backup is that old.
    let backupLastStatus: BackupStatus = {};
    const checkBackups = async () => {
      if (!backupClient || backupChecking) return;
      backupChecking = true;
      try {
        const reached = await backupClient.status().catch(() => undefined);
        let status: BackupStatus;
        if (reached) {
          backupLastStatus = reached;
          status = reached;
        } else {
          const { runningSince: _running, ...known } = backupLastStatus;
          status = known;
        }
        const problem = backupProblem(status, Date.now(), backupWatchSince);
        if (!problem) return;
        const key =
          problem.kind === "failed"
            ? `failed:${problem.at}`
            : `overdue:${problem.lastSuccessAt ?? 0}`;
        if (key === backupAlertKey) return;
        backupAlertKey = key;
        await fs.mkdir(path.dirname(backupAlertFile), { recursive: true });
        await writeFileAtomic(backupAlertFile, `${JSON.stringify({ key })}\n`);
        const projectId = config.projects[0]?.id ?? "home";
        await addToInbox(inboxEntryForBackupProblem(problem, projectId));
        assistantChanged();
      } catch (error) {
        log(`Could not check backups: ${message(error)}`);
      } finally {
        backupChecking = false;
      }
    };
    const backupTimer = backupClient
      ? setInterval(() => void checkBackups(), 10 * 60_000)
      : undefined;
    backupTimer?.unref();
    // Signed heads of the audit log, kept in the backup store.
    if (backupClient) {
      const projectId = config.projects[0]?.id ?? "home";
      const key = await loadCheckpointKey(checkpointKeyFile(config.dataRoot));
      checkpointer = await startAuditCheckpointer({
        key: key!,
        witness: {
          write: (checkpoint) => backupClient.writeCheckpoint(checkpoint),
          list: () => backupClient.checkpoints(),
        },
        head: () => taskAudit.head(),
        hashes: () => readAuditHashes(serverAuditDirectory(config)),
        stateFile: serverCheckpointStateFile(config),
        log,
        onFailure: (error) => {
          void addToInbox(
            inboxEntryForCheckpointProblem(
              { kind: "failed", error },
              projectId,
            ),
          ).then(() => assistantChanged());
        },
        onMismatch: (problems) => {
          void addToInbox(
            inboxEntryForCheckpointProblem(
              { kind: "mismatch", problems },
              projectId,
            ),
          ).then(() => assistantChanged());
        },
      });
    }
    /** Raise or settle the inbox entry a run's new record calls for. */
    const recordInInbox = (run: JobRun, job: JobDefinition) => {
      void (async () => {
        // Answered: the reminder to approve is done with.
        if (run.status === "running") {
          await inbox.markRunRead(run.runId, "needs_approval");
        }
        const history = jobStore.runs(job.id);
        const previous = history.find(
          (other) => other.runId !== run.runId && !isActiveRun(other),
        );
        await addToInbox(inboxEntryForRun(run, job, previous));
        // The usage guard: notice only, the run already finished.
        if (!isActiveRun(run) && run.usage) {
          const usual = unusualUsage(run, history);
          if (usual !== undefined) {
            await addToInbox(inboxEntryForUnusualUsage(run, job, usual));
          }
        }
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
    // Watches check pages through the same connector and rules as
    // `web_fetch`, and only ask a model when the page changed.
    const watcher: Watcher = createWatcher({
      store: watchStore,
      fetch: (request) =>
        fetchWebPage({
          ...request,
          connector: serverWebConnector(config, policyKey),
          keepRaw: true,
        }),
      policy: (projectId) => projectNetworkPolicy(catalog.get(projectId)),
      timeZone: () => persona.get().timeZone,
    });
    // Briefings gather what the server knows itself before their turn.
    const briefings = createBriefings({
      watchChanges: (since, through) =>
        watchStore.all().flatMap((state) => {
          const name = jobStore.get(state.jobId)?.name ?? "A watch";
          return state.findings
            .filter((finding) => finding.at > since && finding.at <= through)
            .map((finding) => ({
              at: finding.at,
              watchName: name,
              summary: finding.summary,
              url: finding.url,
              notified: finding.notified,
            }));
        }),
      openItems: () => briefingOpenItems(taskStore.list(), jobStore),
      webSearch: (projectId) =>
        projectNetworkPolicy(catalog.get(projectId)).preset === "open" &&
        (Boolean(config.web?.searxngUrl) || codex !== undefined),
      timeZone: () => persona.get().timeZone,
      // Calendar and email: the owner's MCP read tools on Run, if any.
      personal: (area) =>
        personalConnection(mcpRegistry.list(), area, (serverId, tool) =>
          mcpRegistry.runRefusal(serverId, tool),
        ),
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
      paused: workPaused,
      prepareRun: async (job, _run, signal) => {
        if (job.briefing) {
          const prepared = briefings.prepare(job, jobStore.runs(job.id));
          return {
            prompt: prepared.prompt,
            record: { briefing: prepared.record },
          };
        }
        if (!job.watch) return undefined;
        const check = await watcher.check(job, signal);
        switch (check.kind) {
          case "quiet":
            return {
              finish: { status: "completed", summary: check.summary },
              record: { watch: check.record },
            };
          case "failed":
            return {
              finish: {
                status: "failed",
                error: check.error,
                errorDetail: check.detail,
              },
              record: { watch: check.record },
            };
          case "changed":
            return { prompt: check.prompt, record: { watch: check.record } };
        }
      },
      finishRun: async (job, run, text) => {
        if (job.briefing) {
          const briefing = briefings.finish(run, text);
          return briefing ? { briefing } : {};
        }
        if (!job.watch || run.watch?.outcome !== "changed") return {};
        const judged = await watcher.judge(job, run, text);
        if (judged.noisy) {
          await addToInbox(
            inboxEntryForWatchNoise(judged.noisy.count, job.projectId),
          );
        }
        return {
          watch: judged.record,
          ...(judged.summary ? { summary: judged.summary } : {}),
        };
      },
      onJobDeleted: (jobId) => {
        void watcher.forget(jobId).catch((error: unknown) => {
          log(`Could not delete a watch's snapshots: ${message(error)}`);
        });
      },
      onRunRecovered: ({ run, job }) => recordInInbox(run, job),
      onRunChanged: ({ run, job, auth, prompt }) => {
        const bridge = bridges.get(run.projectId);
        // Live in its chat while it works; a finished chat once it ends.
        if (bridge && run.sessionId) {
          if (isActiveRun(run)) {
            bridge.followSession(auth, run.sessionId, {
              title: run.title ?? job.name,
              prompt: prompt ?? job.prompt,
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
    let runnerManager: RunnerManagerClient | undefined;
    // Browser editors for task folders (Open editor / Take over).
    let taskEditors: TaskEditors | undefined;
    let editorProxy: EditorProxy | undefined;
    let editorModels: EditorModelServer | undefined;
    // AgentLink in an editor calls models through these, never with a key.
    const editorBackends = config.editor
      ? providers.map((provider) => createWorkspaceModelBackend(provider))
      : [];
    if (config.runners && config.projectsRoot) {
      const runnersConfig = config.runners;
      runnerManager = createRunnerManagerClient({
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
        // MCP calls run here; a runner never sees a token.
        approvalHostTools: (projectId) =>
          mcpToolsFor(projectId, { network: false }).approvalTools,
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
    // Browser research: one throwaway browser per chat, through the gateway.
    const browserProxy = config.commandWorker?.egressProxy;
    if (config.browser && runnerManager && browserProxy) {
      const manager = runnerManager;
      const proxyServer = new URL(browserProxy);
      browserPool = createBrowserPool({
        start: (id) =>
          manager.startBrowser({
            id,
            proxy: `http://${proxyServer.host}`,
          }),
        stop: async (id) => {
          await manager.stopBrowser(id);
        },
        connect: (host, port) => connectCdp(host, port),
        // The project's signed policy, answered to the gateway's challenge.
        credentials: (projectId) => {
          if (!policyKey) return undefined;
          const signed = new URL(
            egressProxyUrl(
              browserProxy,
              policyKey,
              projectNetworkPolicy(catalog.get(projectId)),
            ),
          );
          return {
            username: decodeURIComponent(signed.username),
            password: decodeURIComponent(signed.password),
          };
        },
        idleMs: config.browser.idleMinutes * 60_000,
        log,
      });
      // Left over from a previous run.
      await manager.stopAllBrowsers().catch((error: unknown) => {
        log(`Could not stop leftover browsers: ${message(error)}`);
      });
      log(
        "Browser research: one throwaway browser per chat, through the egress gateway",
      );
    } else if (config.browser) {
      log(
        "Browser research is off: it needs session runners and the egress gateway (commandWorker.egressProxy)",
      );
    }
    // A chat's browser stops when its turn ends.
    const stopBrowsersOnTurnEnd = routes.events.observe((key, { event }) => {
      if (!browserPool || event.kind !== "turn") return;
      const type = event.event.type;
      if (type !== "turn.completed" && type !== "turn.failed") return;
      const session = parseSessionKey(key);
      if (session) void browserPool.end(session.sessionId);
    });
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
                  // As it is when the runner starts.
                  defaultModel: currentDefaultModel(),
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
                  // Read when the runner starts: the name, time zone and
                  // date as they are then.
                  get instructions() {
                    return `${personaBlock("task")}\n\n${AUTO_CONTINUE_INSTRUCTIONS}`;
                  },
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
            // Read when a task starts without its own model.
            get defaultModel() {
              return currentDefaultModel();
            },
            // Reviews go to another provider: Codex work is reviewed by
            // Claude (through Meridian) and the reverse.
            reviewModel: (implementer) =>
              pickReviewModel(implementer, {
                roleModel: config.modelRoles?.review,
                available: availableModels(),
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
            paused: workPaused,
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
                const deleting = taskStore.get(taskId);
                const sessionId = deleting?.sessionId;
                await taskEditors?.stop(taskId);
                await runner.delete(taskId);
                // Its chats, their events and its Inbox entries go too.
                if (deleting) {
                  await removeTaskData({
                    dataRoot: config.dataRoot,
                    task: deleting,
                    events: routes.events,
                    sessionKey: routes.operations.sessionKey,
                    inbox,
                  }).catch((error: unknown) => {
                    log(
                      `Could not remove task ${taskId}'s chats: ${message(error)}`,
                    );
                  });
                  assistantChanged();
                }
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
    if (config.editor && runnerManager && tasks) {
      const editorRunner = tasks.runner;
      const proxy = config.commandWorker?.egressProxy;
      const modelsHost = config.runners?.controlHost ?? "assistant";
      const modelsPort = config.editor.modelsPort;
      taskEditors = createTaskEditors({
        manager: runnerManager,
        // AgentLink's connection to the assistant, with this editor's token.
        settings: (token) =>
          editorAgentLinkSettings({
            baseUrl: `http://${modelsHost}:${modelsPort}/editor-models/${token}/v1`,
            backends: editorBackends,
            // The editor's default is its first model: the current default.
            // An editor already open keeps the list it started with.
            models: (() => {
              const current = currentDefaultModel();
              const models = availableModels();
              return [
                ...models.filter(sameModel(current)),
                ...models.filter((model) => !sameModel(current)(model)),
              ];
            })(),
            noProxy: [modelsHost],
          }),
        noProxy: [modelsHost],
        // Package registries plus Open VSX, for extensions.
        ...(proxy
          ? {
              proxyUrl: () =>
                egressProxyUrl(proxy, policyKey, {
                  preset: "dependencies",
                  allow: ["open-vsx.org", "*.open-vsx.org"],
                }),
            }
          : {}),
        ready: waitForEditor,
        idleMs: config.editor.idleMinutes * 60_000,
        // A taken-over editor left idle goes back to the task.
        onIdle: async (taskId, mode) => {
          if (mode !== "rw" || taskStore.get(taskId)?.state !== "editing") {
            return;
          }
          await taskAudit
            .request(taskId, "hand_back", { kind: "owner" }, Date.now(), {
              idle: true,
            })
            .catch(() => undefined);
          await editorRunner.handBack(taskId, { idle: true });
        },
        log,
      });
    }
    const taskRoutes = createTaskRoutes({
      store: taskStore,
      repositories: repositorySettings,
      connections: githubConnections,
      runner: tasks?.runner,
      audit: taskAudit,
      checkpoints: () => checkpointer?.status(),
      isOwner: (auth) =>
        server !== undefined &&
        auth.principal.subjectId === server.store.ownerId,
      models: availableModels,
      ...(taskEditors && config.editor
        ? { editors: { port: config.editor.port, editors: taskEditors } }
        : {}),
    });
    const jobRoutes = createJobRoutes({
      store: jobStore,
      runner: jobs,
      isOwner: (auth) =>
        server !== undefined &&
        auth.principal.subjectId === server.store.ownerId,
      hasProject: (projectId) => bridges.has(projectId),
      models: availableModels,
      // The owner's, as set in Settings.
      get defaultTimeZone() {
        return persona.get().timeZone;
      },
      watchSummary: (jobId) => {
        const state = watchStore.get(jobId);
        if (!state) return undefined;
        return {
          ...(state.checkedAt !== undefined
            ? { checkedAt: state.checkedAt }
            : {}),
          snapshots: state.snapshots.length,
          recentChanges: state.findings
            .slice(-5)
            .reverse()
            .map((finding) => ({
              at: finding.at,
              summary: finding.summary,
              notified: finding.notified,
              ...(finding.sessionId ? { sessionId: finding.sessionId } : {}),
            })),
        };
      },
    });
    const personaRoutes = createPersonaRoutes({
      store: persona,
      isOwner: (auth) =>
        server !== undefined &&
        auth.principal.subjectId === server.store.ownerId,
      onChanged: () => {
        quietPush.reschedule();
        assistantChanged();
      },
    });
    const onboardingRoutes = createOnboardingRoutes({
      store: onboarding,
      facts: async () => {
        const accounts = codex
          ? await codex.manager.listAccounts().catch(() => [])
          : [];
        let backup: {
          configured: boolean;
          lastSuccessAt?: number;
          failing?: boolean;
          reachable?: boolean;
        } = { configured: false };
        if (backupClient) {
          const status = await backupClient.status().catch(() => undefined);
          const success = status?.lastSuccess?.at;
          const failure = status?.lastFailure?.at;
          backup = {
            configured: true,
            reachable: status !== undefined,
            ...(success !== undefined ? { lastSuccessAt: success } : {}),
            failing:
              status === undefined ||
              (failure !== undefined &&
                (success === undefined || failure > success)),
          };
        }
        return {
          model: {
            codexAvailable: codex !== undefined,
            codexSignedIn: accounts.length > 0,
            otherProviders: config.providers.filter(
              (provider) => provider.type !== "codex",
            ).length,
            openAiKeyAvailable: managedProviders.offered,
            openAiKeySaved: managedProviders.hasOpenAiKey(),
          },
          backup,
          features: onboardingFeatures(config),
        };
      },
      isOwner: (auth) =>
        server !== undefined &&
        auth.principal.subjectId === server.store.ownerId,
    });
    const providerRoutes = createProviderRoutes({
      codex,
      isOwner: (auth) =>
        server !== undefined &&
        auth.principal.subjectId === server.store.ownerId,
      onSignedIn: () => assistantChanged(),
      log,
    });
    const managedProviderRoutes = createManagedProviderRoutes({
      providers: managedProviders,
      openAiModels: managedChoices,
      availableModels,
      defaultModel: currentDefaultModel,
      isOwner: (auth) =>
        server !== undefined &&
        auth.principal.subjectId === server.store.ownerId,
    });
    // A saved or removed key, or a new default: every open chat offers the
    // current models at once (new requests already read the key live).
    managedProviders.onChange(() => {
      for (const bridge of bridges.values()) bridge.modelsChanged();
      assistantChanged();
    });
    const storageRoutes = createStorageRoutes({
      isOwner: (auth) =>
        server !== undefined &&
        auth.principal.subjectId === server.store.ownerId,
      measure: () =>
        measureStorage({
          dataRoot: config.dataRoot,
          projectRoots: config.projectsRoot
            ? [config.projectsRoot]
            : config.projects.map((project) => project.root),
        }),
    });
    const memoryRoutes = createMemoryRoutes({
      memory,
      isOwner: (auth) =>
        server !== undefined &&
        auth.principal.subjectId === server.store.ownerId,
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
        if (
          await stopTaskOrRun(entry.sessionId, {
            kind: "owner",
            device: auth.session.deviceLabel,
          })
        ) {
          return;
        }
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
    const updateRoutes = createUpdateRoutes({
      client: updaterClient,
      isOwner: (auth) =>
        server !== undefined &&
        auth.principal.subjectId === server.store.ownerId,
    });
    const backupRoutes = createBackupRoutes({
      client: backupClient,
      checkpoints: () => checkpointer?.status(),
      isOwner: (auth) =>
        server !== undefined &&
        auth.principal.subjectId === server.store.ownerId,
      onFinished: () => void checkBackups(),
      log,
    });
    const mcpRoutes = createMcpRoutes({
      registry: mcpRegistry,
      refresh: refreshMcpServer,
      onChanged: () => assistantChanged(),
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
        (await personaRoutes.handleRequest(request, response, auth)) ||
        (await onboardingRoutes.handleRequest(request, response, auth)) ||
        (await providerRoutes.handleRequest(request, response, auth)) ||
        (await managedProviderRoutes.handleRequest(request, response, auth)) ||
        (await storageRoutes.handleRequest(request, response, auth)) ||
        (await memoryRoutes.handleRequest(request, response, auth)) ||
        (await updateRoutes.handleRequest(request, response, auth)) ||
        (await pushRoutes.handleRequest(request, response, auth)) ||
        (await githubRoutes.handleRequest(request, response, auth)) ||
        (await backupRoutes.handleRequest(request, response, auth)) ||
        (await mcpRoutes.handleRequest(request, response, auth)) ||
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
        await maintenance?.close();
        await jobs.close();
        await tasks?.runner.close();
        // Editor sessions live in this process: their editors go with it.
        await editorProxy?.close();
        await editorModels?.close();
        await taskEditors?.close();
        await taskEditors?.stopAll().catch((error: unknown) => {
          log(`Could not stop the task editors: ${message(error)}`);
        });
        stopBrowsersOnTurnEnd();
        await browserPool?.endAll().catch((error: unknown) => {
          log(`Could not stop the research browsers: ${message(error)}`);
        });
        await taskDeliveries.flush();
        await taskStore.flush();
        await taskAudit.flush();
        await checkpointer?.close();
        await taskInboxWrites;
        clearInterval(watchTimer);
        if (backupTimer) clearInterval(backupTimer);
        stopWatching();
        await inbox.flush();
        quietPush.close();
        await push.close();
        await pushLog.flush();
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
    // Read a drain request before anything can start work: a server
    // started mid-upgrade stays drained until `agentlink-server resume`.
    const taskWork = tasks?.runner;
    maintenance = createMaintenance({
      dataRoot: config.dataRoot,
      log,
      running: () => {
        const working = taskWork?.workingTasks() ?? [];
        const runs = jobs.activeRuns();
        const ownSessions = new Set(
          [
            ...working.map((task) => task.sessionId),
            ...runs.map(({ run }) => run.sessionId),
          ].filter((id): id is string => id !== undefined),
        );
        return [
          ...working.map(
            (task) =>
              `task ${task.id} (${task.state === "awaiting_approval" ? "waiting for your approval" : task.state}): ${task.objective.replace(/\s+/gu, " ").slice(0, 60)}`,
          ),
          ...runs.map(({ job }) => `scheduled run of "${job.name}"`),
          ...routes
            .runningSessions()
            .map((key) => parseSessionKey(key))
            .filter(
              (parsed) =>
                parsed !== undefined &&
                !parsed.projectId.startsWith(TASK_PROJECT_PREFIX) &&
                !ownSessions.has(parsed.sessionId),
            )
            .map(
              (parsed) =>
                `a chat turn in ${catalog.get(parsed!.projectId)?.label ?? parsed!.projectId}`,
            ),
        ];
      },
      interrupt: async (reason) => {
        const stoppedTasks = (await taskWork?.interruptWorking(reason)) ?? [];
        const stoppedRuns = await jobs.interruptRuns(reason);
        // Chats last: tasks and runs have stopped their own turns.
        const stoppedChats = await routes.interruptTurns((key) => {
          const parsed = parseSessionKey(key);
          return (
            parsed !== undefined &&
            !parsed.projectId.startsWith(TASK_PROJECT_PREFIX)
          );
        });
        // Tasks and runs say so in the Inbox already; chats say so here,
        // since the chat itself just ends.
        for (const key of stoppedChats) {
          const chat = parseSessionKey(key);
          if (!chat) continue;
          await addToInbox(inboxEntryForInterruptedChat(chat)).catch(
            (error: unknown) => {
              log(`Could not update the inbox: ${message(error)}`);
            },
          );
        }
        return [
          ...stoppedTasks.map((task) => `task ${task.id}`),
          ...stoppedRuns.map((run) => `scheduled run ${run.runId}`),
          ...stoppedChats.map(
            (key) => `a chat turn (${parseSessionKey(key)?.sessionId ?? key})`,
          ),
        ];
      },
      onChanged: (status) => {
        if (status.state === "running") {
          jobs.wake();
          taskWork?.wake();
        }
        assistantChanged();
      },
    });
    await maintenance.start();
    const { port } = await server.start();
    // Services that answer with another build or protocol: rebuild them.
    void serviceVersions(config, env)
      .then((services) => {
        for (const problem of versionProblems(
          SERVER_BUILD,
          services.filter((service) => service.reachable),
        )) {
          log(`Version mismatch: ${problem}`);
        }
      })
      .catch(() => undefined);
    if (taskEditors && config.editor) {
      // Editors an earlier process started have no sessions any more.
      await taskEditors.stopAll().catch((error: unknown) => {
        log(`Could not stop earlier task editors: ${message(error)}`);
      });
      const editorsForModels = taskEditors;
      editorModels = await startEditorModelServer({
        backends: editorBackends,
        models: availableModels,
        authorize: (token) => editorsForModels.modelAccess(token),
        listen: { host: "0.0.0.0", port: config.editor.modelsPort },
        log,
      });
      editorProxy = await startEditorProxy({
        editors: taskEditors,
        tls,
        listen: { host: config.listen.host, port: config.editor.port },
        hosts: config.publicOrigins.map((origin) =>
          new URL(origin).hostname.replace(/^\[|\]$/gu, ""),
        ),
        log,
      });
    }
    const appServer = server;
    certificates?.watch({
      setTls(next) {
        appServer.setTls(next);
        editorProxy?.setTls(next);
      },
    });
    // Started from a restored backup: pause schedules before any can fire,
    // and tell the owner what was restored.
    const restored = await takeRestoredMarker(config.dataRoot);
    if (restored) {
      const paused: string[] = [];
      for (const job of jobStore.list()) {
        if (!job.enabled) continue;
        await jobStore.update(job.id, { enabled: false }, Date.now());
        paused.push(job.name);
      }
      await addToInbox(
        inboxEntryForRestore(
          restored,
          paused,
          config.projects[0]?.id ?? "home",
        ),
      );
      log(
        `Started from restored backup ${restored.snapshotId.slice(0, 8)}; paused ${paused.length} scheduled job(s)`,
      );
    }
    await jobs.start();
    if (backupClient) {
      setTimeout(() => void checkBackups(), 60_000).unref();
    }
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

/**
 * How long a chat's push waits: an open window viewing the chat reads its
 * entry first, so the owner's phone does not buzz for what they watch.
 */
const CHAT_PUSH_DELAY_MS = 30_000;

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

/** Wait until a just-started code-server answers, for up to 20 seconds. */
async function waitForEditor(url: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/healthz", url), {
        signal: AbortSignal.timeout(2_000),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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
