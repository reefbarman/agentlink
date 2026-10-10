import type { HostToolResolver } from "@agentlink/core";
import { createNodeHostLocalFileSystem } from "@agentlink/node-host";
import {
  createLocalWorkspaceExecutionBackend,
  createWorkspaceHost,
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
import { createJobRunner } from "./jobRunner.js";
import { serverTimeZone } from "./jobSchedule.js";
import {
  isActiveRun,
  openJobStore,
  type JobDefinition,
  type JobRun,
} from "./jobStore.js";
import { createInboxRoutes } from "./inboxRoutes.js";
import { inboxEntryForRun, openInboxStore } from "./inboxStore.js";
import { createPushRoutes } from "./pushRoutes.js";
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
import { bundledWebAssets } from "./webAssets.js";
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
  /** Replaces sending to the push services; tests only. */
  readonly pushTransport?: PushTransport;
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
    const openHost = async (project: {
      readonly id: string;
      readonly root: string;
    }) => {
      const autonomous = (request: { readonly sessionId: string }) =>
        approvalModes.get(project.id, request.sessionId) === "autonomous";
      const host = await createWorkspaceHost({
        projectRoot: project.root,
        dataRoot: path.join(config.dataRoot, "workspace"),
        ownerId,
        providers,
        defaultModel: config.defaultModel,
        promptIdentity: { role: "a personal assistant" },
        ...commandHostOptions(config, worker, autonomous, {
          policy: () => projectNetworkPolicy(catalog.get(project.id)),
          key: policyKey,
        }),
        hostTools: projectWebTools(config, {
          policy: () => projectNetworkPolicy(catalog.get(project.id)),
          key: policyKey,
          ...(codex ? { codex: codex.provider } : {}),
        }),
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
        // Stop in a run's chat stops the run, recorded as cancelled.
        stopRun: async (workspaceSessionId) => {
          const job = jobStore
            .list()
            .find((candidate) =>
              jobStore
                .runs(candidate.id)
                .some(
                  (run) =>
                    isActiveRun(run) && run.sessionId === workspaceSessionId,
                ),
            );
          if (job) await jobs.stopJob(job.id, "cancelled");
        },
      });
    for (const { id } of hosts) {
      const opened = await openBridge(id);
      bridges.set(id, opened);
    }
    const chat = createProjectChats({
      catalog,
      bridges,
      models: configuredModels(config),
      log,
      ...(config.projectsRoot
        ? {
            clone: createGitCloner({
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
            }),
          }
        : {}),
      openProject: async (entry) => {
        const host = await openHost(entry);
        routes.addProject(mountFor(entry.id, host));
        const bridge = await openBridge(entry.id);
        bridges.set(entry.id, bridge);
        return bridge;
      },
    });
    /** Raise or settle the inbox entry a run's new record calls for. */
    const recordInInbox = (run: JobRun, job: JobDefinition) => {
      void (async () => {
        // Answered: the reminder to approve is done with.
        if (run.status === "running") {
          await inbox.markRunRead(run.runId, "needs_approval");
        }
        const entry = inboxEntryForRun(run, job);
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
      })()
        .catch((error: unknown) => {
          log(`Could not update the inbox: ${message(error)}`);
        })
        .finally(assistantChanged);
    };
    // Each run is a new chat in its project, acting for the owner.
    const jobs = createJobRunner({
      store: jobStore,
      operations: routes.operations,
      events: routes.events,
      ownerId: () => server?.store.ownerId,
      resolveModel,
      projectDefaults,
      log,
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
    });
    const pushRoutes = createPushRoutes({
      push,
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
        (await inboxRoutes.handleRequest(request, response, auth)) ||
        (await pushRoutes.handleRequest(request, response, auth)) ||
        (await routes.handleRequest(request, response, auth)),
      deviceNotifications: {
        isOn: (deviceId) => push.isSubscribed(deviceId),
        turnOff: async (deviceId) => {
          await push.unsubscribe(deviceId);
        },
      },
      onClose: async () => {
        // Before the routes stop turns: open runs are recorded interrupted.
        await jobs.close();
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
