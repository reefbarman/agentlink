import {
  preflightAssistantService,
  serverAccessDataRoot,
  serverAuditDirectory,
  serverCheckpointStateFile,
  serverTlsDirectory,
  startAssistantService,
  type AssistantService,
} from "./assistantService.js";
import { readAuditHashes, verifyTaskAudit } from "./taskAudit.js";
import {
  checkpointKeyFile,
  loadCheckpointKey,
  verifyCheckpoints,
  type CheckpointStatus,
} from "./auditCheckpoint.js";
import {
  BackupError,
  restoreSnapshot,
  resticRunner,
  type ResticRunner,
} from "./backup.js";
import { startBackupAgent } from "./backupAgent.js";
import { BackupRequestError, createBackupClient } from "./backupClient.js";
import { startCommandWorker } from "./commandWorker.js";
import { canExecuteOnCommandWorker } from "./commandWorkerClient.js";
import { DATA_VERSION, readDataVersion } from "./dataVersion.js";
import {
  DEFAULT_DRAIN_WAIT_MS,
  readMaintenanceStatus,
  requestDrain,
  requestResume,
} from "./maintenance.js";
import net from "node:net";
import { SERVER_BUILD, describeBuild, versionProblems } from "./serverBuild.js";
import { serviceVersions } from "./serviceVersions.js";
import {
  DEFAULT_EGRESS_ALLOWLIST,
  parseEgressAllowlist,
  startEgressGateway,
} from "./egressGateway.js";
import {
  egressPolicyAuthorizer,
  parseNetworkPolicyKey,
} from "./egressPolicy.js";
import { promises as fs } from "node:fs";
import {
  localTlsHostsFromOrigins,
  readLocalCertificateAuthority,
} from "./localCertificateAuthority.js";
import {
  createServerCodexRuntime,
  describeCodexSignIn,
  hasCodexProvider,
} from "./codexSignIn.js";
import { encode } from "uqr";
import { parseVaultKey } from "./publisherVault.js";
import { startPublisher } from "./publisher.js";
import { RUNNER_MANAGER_PORT, startRunnerManager } from "./runnerManager.js";
import {
  RUNNER_DATA_ROOT,
  RUNNER_ENV,
  RUNNER_PORT,
  startSessionRunner,
  type SessionRunnerSpec,
} from "./sessionRunner.js";

import { pairingLink } from "./accessPages.js";
import {
  issueLocalPairingCode,
  ServerAccessError,
} from "./ServerAccessStore.js";
import {
  loadAssistantServerConfig,
  prepareSecret,
  usesLocalCa,
  type AssistantServerConfig,
} from "./serverConfig.js";

export interface AssistantServerCliIo {
  /** Command output (help, check results). */
  readonly stdout: (text: string) => void;
  /** Operator log and errors. Under a service manager this is the journal. */
  readonly log: (line: string) => void;
  readonly env: NodeJS.ProcessEnv;
  /** Resolves with the signal name when the process should stop. */
  readonly waitForShutdown: () => Promise<string>;
  /** One line from the operator's terminal; undefined at end of input. */
  readonly readLine?: () => Promise<string | undefined>;
  /** Observes the running service; used by tests. */
  readonly onStarted?: (service: AssistantService) => void;
}

export const ASSISTANT_SERVER_USAGE = `Usage: agentlink-server --config <file> [--check]
       agentlink-server pair --config <file>
       agentlink-server export-ca --config <file> > agentlink-ca.pem
       agentlink-server codex-login --config <file>
       agentlink-server codex-logout --config <file>
       agentlink-server audit-check --config <file> [--checkpoints]
                                    [--directory <dir>]
       agentlink-server backup --config <file>
       agentlink-server backups --config <file>
       agentlink-server drain --config <file> [--wait <minutes>] [--reason <text>]
       agentlink-server resume --config <file>
       agentlink-server smoke-check --config <file>
       agentlink-server backup-agent --token-file <file> --repository-file <file>
                                     --password-file <file> --deploy-root <dir>
                                     --state <dir> [--listen <host:port>]
       agentlink-server restore --repository-file <file> --password-file <file>
                                --target <empty dir> [--snapshot <id>|latest]
                                [--reason upgrade-rollback]
       agentlink-server command-worker --token-file <file> --root <dir>...
                                       [--listen <host:port>]
                                       [--allow-local-peers] [--reap-orphans]
       agentlink-server egress-gateway [--listen <host:port>]
                                       [--allow <host>]... [--no-default-allow]
                                       [--policy-key-file <path>]
       agentlink-server publisher --token-file <file> --key-file <file>
                                  --tasks-root <dir> --data <dir>
                                  [--client-id <id>] [--listen <host:port>]
       agentlink-server runner-manager --token-file <file> --image <name>
                                       --network <name> --projects-root <dir>
                                       --data-root <dir> [--listen <host:port>]
                                       [--user <uid:gid>] [--memory <size>]
                                       [--cpus <n>] [--pids <n>]
                                       [--docker-socket <path>]
                                       [--projects-host-root <dir>]
                                       [--data-host-root <dir>]
       agentlink-server session-runner [--data <dir>] [--listen <host:port>]

Runs the AgentLink assistant server over HTTPS.

Options:
  --config <file>  Server configuration (JSON). Required unless the
                   AGENTLINK_SERVER_CONFIG environment variable is set
                   (the container image sets it).
  --check          Validate the configuration, TLS files, project
                   directories, and provider secrets, then exit.
  --help           Show this help.

Commands:
  pair             Print a single-use 6-digit pairing code (10 minutes),
                   a sign-in link, and a QR code for signing in a browser
                   or phone: the first one, or any device once every
                   signed-in device is lost. Signed-in devices can pair
                   others from /devices. Run it on the server machine as
                   the service account; it works whether or not the
                   server is running, and running it again replaces the
                   code.
  export-ca        With "tls": { "localCa": true }, print the server's
                   local CA certificate (PEM) to install on devices. Its
                   SHA-256 fingerprint goes to stderr so you can compare
                   it on each device.
  codex-login      Sign in with ChatGPT for "codex" providers. Open the
                   printed link on any device, then paste back the
                   address the browser ends on (http://localhost:1455/...,
                   which does not load). Run it as the service account.
                   The running server uses the new sign-in immediately.
  codex-logout     Remove every stored ChatGPT sign-in.
  drain            Before an upgrade: stop admitting new work (chats,
                   tasks, scheduled runs), wait for running work (up to
                   --wait minutes, default 15), then record what is left
                   interrupted so it can be resumed. The server stays
                   drained, across restarts, until \`resume\`. Run it on the
                   server machine as the service account, like \`pair\`.
  resume           Start admitting new work again after \`drain\`.
  audit-check      Check the task audit log's hash chain. --checkpoints
                   also checks it against the signed checkpoints in the
                   backup store, which catches a log rewritten consistently
                   with its head. --directory checks a copy of the log
                   instead of data/audit. Exits 1 on any problem.
  smoke-check      Check the running deployment: the server answers, the
                   data format is current, and every service is reachable
                   and runs this same version. Exits 1 on any problem
                   (deploy/upgrade.sh rolls back on it).
  command-worker   Run approved commands for a server whose configuration
                   has "commandWorker" (normally in its own container).
                   Needs no server configuration: --token-file is the
                   shared token (chmod 600), each --root is a directory
                   commands may run in, and --listen defaults to
                   0.0.0.0:7300. Only reachable peers holding the token
                   can run anything, so keep it on a private network.
                   Connections from the worker's own machine are refused
                   (commands could read the token) unless
                   --allow-local-peers is given for a same-host server.
                   --reap-orphans kills leftover processes whenever no
                   command runs; use it only alone in a container.
  egress-gateway   HTTPS-only proxy that lets commands on the worker reach
                   allowlisted hosts (set the server's
                   "commandWorker.egressProxy" to it). --listen defaults to
                   0.0.0.0:3128. The allowlist is a built-in set of package
                   registries and GitHub hosts, plus each --allow and the
                   comma- or space-separated AGENTLINK_EGRESS_ALLOW
                   variable (host names or *.domain wildcards).
                   --policy-key-file (or AGENTLINK_EGRESS_POLICY_KEY_FILE)
                   names the key the server signs per-project network
                   policies with; requests carrying one follow it, and
                   requests without credentials keep this allowlist.
                   --no-default-allow drops the built-in set. Anything else,
                   plain HTTP, IP addresses, ports other than 443, and names
                   that resolve to private addresses are refused with a 403
                   naming the host.
  publisher        Hold the GitHub connections' tokens and publish coding
                   tasks for a server whose configuration has "publisher"
                   (normally in its own container): push a task's commit to
                   its agentlink/* branch, never forced, and open or update
                   its draft pull request. --token-file is the token shared
                   with the server, --key-file encrypts the stored
                   connections (both chmod 600, 32 bytes as hex), each task
                   clone must be under --tasks-root (mounted read-only), and
                   --data holds the encrypted connections. --client-id (or
                   AGENTLINK_GITHUB_CLIENT_ID) is your GitHub App's client
                   ID for "Connect GitHub"; without it only pasted tokens
                   work. --listen defaults to 0.0.0.0:7400.
  runner-manager   Start and stop session runners (one container per coding
                   task's session) for a server whose configuration has
                   "runners". The only AgentLink process with the Docker
                   socket. It accepts start and stop from the server's token
                   (--token-file) and decides the rest: --image (the
                   command worker image), --network (an internal network),
                   --user (default 1000:1000), --memory (default 2g),
                   --cpus (default 2) and --pids (default 512) per runner,
                   a read-only root filesystem and no capabilities. Only
                   the task's folder (under --projects-root/.tasks) and its
                   data folder (under --data-root) are mounted; both must be
                   mounted here at the same paths as in the server, and
                   their host paths are read from this container's mounts
                   unless --projects-host-root and --data-host-root are
                   given. --listen defaults to 0.0.0.0:7700.
  session-runner   Run one coding task's session (started by the runner
                   manager, which sets AGENTLINK_RUNNER_TOKEN,
                   AGENTLINK_RUNNER_CONTROL_URL and AGENTLINK_RUNNER_SPEC).
                   --data defaults to /var/lib/agentlink-runner and --listen
                   to 0.0.0.0:7600.
`;

const DEFAULT_COMMAND_WORKER_LISTEN = "0.0.0.0:7300";
const DEFAULT_EGRESS_GATEWAY_LISTEN = "0.0.0.0:3128";
const DEFAULT_PUBLISHER_LISTEN = "0.0.0.0:7400";

const COMMANDS = new Set([
  "pair",
  "export-ca",
  "codex-login",
  "codex-logout",
  "audit-check",
  "backup",
  "backups",
  "drain",
  "resume",
  "smoke-check",
]);

/** Returns the process exit code. */
export async function runAssistantServerCli(
  argv: readonly string[],
  io: AssistantServerCliIo,
): Promise<number> {
  if (argv[0] === "command-worker") {
    return await runCommandWorker(argv.slice(1), io);
  }
  if (argv[0] === "egress-gateway") {
    return await runEgressGateway(argv.slice(1), io);
  }
  if (argv[0] === "publisher") {
    return await runPublisher(argv.slice(1), io);
  }
  if (argv[0] === "runner-manager") {
    return await runRunnerManager(argv.slice(1), io);
  }
  if (argv[0] === "session-runner") {
    return await runSessionRunner(argv.slice(1), io);
  }
  if (argv[0] === "backup-agent") {
    return await runBackupAgent(argv.slice(1), io);
  }
  if (argv[0] === "restore") {
    return await runRestore(argv.slice(1), io);
  }
  const command = argv[0] && COMMANDS.has(argv[0]) ? argv[0] : undefined;
  let configPath: string | undefined;
  let check = false;
  let drainWaitMinutes: number | undefined;
  let drainReason: string | undefined;
  let auditCheckpoints = false;
  let auditDirectory: string | undefined;
  for (let index = command ? 1 : 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      io.stdout(ASSISTANT_SERVER_USAGE);
      return 0;
    }
    if (argument === "--check" && !command) {
      check = true;
    } else if (argument === "--wait" && command === "drain") {
      const minutes = Number(argv[index + 1]);
      index += 1;
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) {
        return usageError(io, "--wait needs minutes, from 0 to 1440");
      }
      drainWaitMinutes = minutes;
    } else if (argument === "--checkpoints" && command === "audit-check") {
      auditCheckpoints = true;
    } else if (argument === "--directory" && command === "audit-check") {
      auditDirectory = argv[index + 1];
      index += 1;
      if (!auditDirectory) return usageError(io, "--directory needs a folder");
    } else if (argument === "--reason" && command === "drain") {
      drainReason = argv[index + 1];
      index += 1;
      if (!drainReason) return usageError(io, "--reason needs a value");
    } else if (argument === "--config") {
      configPath = argv[index + 1];
      index += 1;
      if (!configPath) return usageError(io, "--config needs a file path");
    } else if (argument.startsWith("--config=")) {
      configPath = argument.slice("--config=".length);
    } else {
      return usageError(io, `Unknown argument: ${argument}`);
    }
  }
  configPath ??= io.env.AGENTLINK_SERVER_CONFIG || undefined;
  if (!configPath) return usageError(io, "--config is required");

  const config = await loadAssistantServerConfig(configPath);
  if (command === "pair") return await runPair(config, io);
  if (command === "export-ca") return await runExportCa(config, io);
  if (command === "audit-check") {
    return await runAuditCheck(config, io, {
      checkpoints: auditCheckpoints,
      ...(auditDirectory ? { directory: auditDirectory } : {}),
    });
  }
  if (command === "drain") {
    return await runDrain(config, io, {
      ...(drainWaitMinutes !== undefined
        ? { waitMs: drainWaitMinutes * 60_000 }
        : {}),
      ...(drainReason ? { reason: drainReason } : {}),
    });
  }
  if (command === "resume") return await runResume(config, io);
  if (command === "smoke-check") return await runSmokeCheck(config, io);
  if (command === "backup" || command === "backups") {
    return await runBackupCommand(command, config, io);
  }
  if (command === "codex-login" || command === "codex-logout") {
    if (!hasCodexProvider(config)) {
      io.log(
        `agentlink-server: ${command} needs a provider with "type": "codex" in the configuration`,
      );
      return 1;
    }
    return command === "codex-login"
      ? await runCodexLogin(config, io)
      : await runCodexLogout(config, io);
  }
  if (check) {
    const preflight = await preflightAssistantService(config, io.env);
    const tlsSummary =
      preflight.kind === "files"
        ? "TLS from certificate files"
        : preflight.caFingerprint256
          ? `local CA ${preflight.caFingerprint256}`
          : "local CA will be created on first start";
    io.stdout(
      `Configuration OK: ${config.projects.length} project(s), listening on ${config.listen.host}:${config.listen.port} for ${config.publicOrigins.join(", ")}; ${tlsSummary}\n`,
    );
    if (preflight.codexSignIn) io.stdout(`${preflight.codexSignIn}\n`);
    io.stdout(
      `${preflight.commandWorker ?? "Commands: disabled (no commandWorker configured)"}\n`,
    );
    if (preflight.publisher) io.stdout(`${preflight.publisher}\n`);
    if (preflight.runners) io.stdout(`${preflight.runners}\n`);
    if (preflight.backup) io.stdout(`${preflight.backup}\n`);
    if (config.backup) io.stdout(`${await describeCheckpoints(config)}\n`);
    io.stdout(`${await describeVersions(config, io.env)}\n`);
    const maintenance = await readMaintenanceStatus(config.dataRoot);
    if (maintenance && maintenance.state !== "running") {
      io.stdout(
        `Maintenance: ${maintenance.state} for ${maintenance.reason ?? "an upgrade"}; new work waits until \`agentlink-server resume\`\n`,
      );
    }
    return 0;
  }

  const service = await startAssistantService({
    config,
    log: io.log,
    env: io.env,
  });
  io.onStarted?.(service);
  const signal = await io.waitForShutdown();
  io.log(`Received ${signal}; stopping running turns and shutting down`);
  await service.close();
  io.log("AgentLink server stopped");
  return 0;
}

/** `backup`: back up now and wait; `backups`: list the snapshots. */
async function runBackupCommand(
  command: "backup" | "backups",
  config: AssistantServerConfig,
  io: AssistantServerCliIo,
): Promise<number> {
  if (!config.backup) {
    io.log(
      'agentlink-server: no "backup" in the configuration (see Backups in the README)',
    );
    return 1;
  }
  const client = createBackupClient({
    host: config.backup.host,
    port: config.backup.port,
    token: await prepareSecret(config.backup.token, "backup.token", io.env),
  });
  try {
    if (command === "backups") {
      const snapshots = await client.snapshots();
      if (snapshots.length === 0) io.stdout("No backups yet\n");
      for (const snapshot of snapshots) {
        io.stdout(`${snapshot.shortId}  ${snapshot.time}\n`);
      }
      return 0;
    }
    io.stdout("Backing up (this waits for it to finish)...\n");
    const status = await client.backupNow();
    const failure = status.lastFailure;
    if (
      failure &&
      (!status.lastSuccess || failure.at > status.lastSuccess.at)
    ) {
      io.stdout(`Backup failed: ${failure.error}\n`);
      return 1;
    }
    const last = status.lastSuccess;
    io.stdout(
      last
        ? `Backup ${last.snapshotId.slice(0, 8)} done: ${last.files} files, ${last.added} new bytes, ${Math.round(last.durationMs / 1000)}s\n`
        : "Backup finished\n",
    );
    return 0;
  } catch (error) {
    io.log(
      `agentlink-server: ${error instanceof BackupRequestError ? (error.detail ?? error.code) : error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

async function runBackupAgent(
  argv: readonly string[],
  io: AssistantServerCliIo,
): Promise<number> {
  const required = [
    "--token-file",
    "--repository-file",
    "--password-file",
    "--deploy-root",
    "--state",
  ];
  const values: Record<string, string | undefined> = {
    "--listen": "0.0.0.0:7800",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      io.stdout(ASSISTANT_SERVER_USAGE);
      return 0;
    }
    if (![...required, "--listen"].includes(argument)) {
      return usageError(io, `Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) return usageError(io, `${argument} needs a value`);
    values[argument] = value;
    index += 1;
  }
  for (const flag of required) {
    if (!values[flag]) return usageError(io, `${flag} is required`);
  }
  const address = parseListen(values["--listen"]!);
  if (!address) return usageError(io, "--listen must be <host>:<port>");
  const token = await (
    await prepareSecret(
      { file: values["--token-file"]! },
      "--token-file",
      io.env,
    )
  )();
  const state = values["--state"]!;
  const agent = await startBackupAgent({
    host: address.host,
    port: address.port,
    token,
    deployRoot: values["--deploy-root"]!,
    stateDirectory: state,
    restic: resticRunner({
      repositoryFile: values["--repository-file"]!,
      passwordFile: values["--password-file"]!,
      cacheDirectory: `${state.replace(/\/+$/u, "")}/cache`,
    }),
    log: io.log,
  });
  io.log(
    `AgentLink backup agent listening on ${address.host}:${agent.port} for ${values["--deploy-root"]}`,
  );
  const signal = await io.waitForShutdown();
  io.log(`Received ${signal}; stopping the backup agent`);
  await agent.close();
  return 0;
}

/** Restore a backup into an empty directory (run with the service stopped). */
export async function runRestore(
  argv: readonly string[],
  io: AssistantServerCliIo,
  restic?: ResticRunner,
): Promise<number> {
  const values: Record<string, string | undefined> = { "--snapshot": "latest" };
  const known = [
    "--repository-file",
    "--password-file",
    "--target",
    "--snapshot",
    "--reason",
  ];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      io.stdout(ASSISTANT_SERVER_USAGE);
      return 0;
    }
    if (!known.includes(argument)) {
      return usageError(io, `Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) return usageError(io, `${argument} needs a value`);
    values[argument] = value;
    index += 1;
  }
  for (const flag of ["--repository-file", "--password-file", "--target"]) {
    if (!values[flag]) return usageError(io, `${flag} is required`);
  }
  try {
    const restored = await restoreSnapshot({
      restic:
        restic ??
        resticRunner({
          repositoryFile: values["--repository-file"]!,
          passwordFile: values["--password-file"]!,
        }),
      target: values["--target"]!,
      snapshot: values["--snapshot"]!,
      ...(values["--reason"] ? { reason: values["--reason"] } : {}),
    });
    io.stdout(
      `Restored backup ${restored.snapshotId.slice(0, 8)} (taken ${restored.snapshotTime}) into ${values["--target"]}. Start the assistant there: scheduled jobs start paused, and the Inbox says what was restored.\n`,
    );
    return 0;
  } catch (error) {
    io.log(
      `agentlink-server: ${error instanceof BackupError || error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

/** Refuse unless run as the data root's owner, like `pair`. */
async function assertDataOwner(
  config: AssistantServerConfig,
  io: AssistantServerCliIo,
): Promise<boolean> {
  const stats = await fs.stat(config.dataRoot).catch(() => undefined);
  const uid = process.getuid?.();
  if (stats && uid !== undefined && stats.uid !== uid) {
    io.log(
      `agentlink-server: run this as the account that owns ${config.dataRoot} (the service account), for example with sudo -u.`,
    );
    return false;
  }
  return true;
}

async function runDrain(
  config: AssistantServerConfig,
  io: AssistantServerCliIo,
  options: { readonly waitMs?: number; readonly reason?: string },
): Promise<number> {
  if (!(await assertDataOwner(config, io))) return 1;
  io.stdout(
    `Draining: new chats, tasks and scheduled runs wait; running work has ${Math.round((options.waitMs ?? DEFAULT_DRAIN_WAIT_MS) / 60_000)} minute(s) to finish.\n`,
  );
  const outcome = await requestDrain({
    dataRoot: config.dataRoot,
    report: (line) => io.stdout(`${line}\n`),
    ...options,
  });
  if (outcome.kind === "not_running") {
    io.stdout(
      "The server is not running (or did not answer); it will start drained.\n",
    );
    return 0;
  }
  if (outcome.kind === "timed_out") {
    io.stdout(
      `The server did not finish draining${outcome.status?.waiting.length ? `; still running: ${outcome.status.waiting.join("; ")}` : ""}.\n`,
    );
    return 1;
  }
  const { status } = outcome;
  if (status.interrupted.length > 0) {
    io.stdout(
      `Stopped at the deadline (resume them afterwards): ${status.interrupted.join("; ")}\n`,
    );
  }
  if (status.waiting.length > 0) {
    io.stdout(
      `Still stopping (recorded interrupted when the server restarts): ${status.waiting.join("; ")}\n`,
    );
  }
  io.stdout(
    "Drained. New work waits until `agentlink-server resume`, also across restarts.\n",
  );
  return 0;
}

async function runResume(
  config: AssistantServerConfig,
  io: AssistantServerCliIo,
): Promise<number> {
  if (!(await assertDataOwner(config, io))) return 1;
  const outcome = await requestResume({
    dataRoot: config.dataRoot,
    report: (line) => io.stdout(`${line}\n`),
  });
  io.stdout(
    outcome === "resumed"
      ? "Resumed: new chats, tasks and scheduled runs start again.\n"
      : outcome === "not_draining"
        ? "Not drained; nothing to resume.\n"
        : "The server is not running (or did not answer); it will start normally.\n",
  );
  return 0;
}

/** "Versions: ..." for `--check`. */
async function describeVersions(
  config: AssistantServerConfig,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const services = await serviceVersions(config, env);
  // Unreachable services already have their own line.
  const problems = versionProblems(
    SERVER_BUILD,
    services.filter((service) => service.reachable),
  );
  const data = await readDataVersion(config.dataRoot).catch(() => undefined);
  const dataText = `data format ${data ?? "new"}${data !== undefined && data > DATA_VERSION ? ` (newer than this server's ${DATA_VERSION}: it will refuse to start)` : ""}`;
  if (problems.length > 0) {
    return `Versions: assistant ${describeBuild(SERVER_BUILD)}, ${dataText}; ${problems.join("; ")}`;
  }
  return `Versions: assistant ${describeBuild(SERVER_BUILD)}${services.length > 0 ? `, and ${services.length} service(s) on the same build` : ""}; ${dataText}`;
}

/**
 * After an upgrade: is the running deployment healthy and on one version?
 * Exit 1 on any problem. No model calls, no changes.
 */
async function runSmokeCheck(
  config: AssistantServerConfig,
  io: AssistantServerCliIo,
): Promise<number> {
  const problems: string[] = [];
  const ok = (line: string) => io.stdout(`ok    ${line}\n`);
  const fail = (line: string) => {
    problems.push(line);
    io.stdout(`FAIL  ${line}\n`);
  };
  const host =
    config.listen.host === "0.0.0.0" || config.listen.host === "::"
      ? "127.0.0.1"
      : config.listen.host;
  const listening = await new Promise<string | undefined>((resolve) => {
    const socket = net.connect({ host, port: config.listen.port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("timed out");
    }, 5_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(undefined);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve(error.message);
    });
  });
  if (listening) {
    fail(`server on ${host}:${config.listen.port}: ${listening}`);
  } else {
    ok(`server answers on ${host}:${config.listen.port}`);
  }
  try {
    const data = await readDataVersion(config.dataRoot);
    if (data === undefined) fail("data format: no VERSION yet");
    else if (data !== DATA_VERSION) {
      fail(`data format ${data}, this server expects ${DATA_VERSION}`);
    } else ok(`data format ${data}`);
  } catch (error) {
    fail(
      `data format: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const services = await serviceVersions(config, io.env, 5_000);
  const problemsByService = new Map(
    services.map((service) => [
      service.name,
      versionProblems(SERVER_BUILD, [service])[0],
    ]),
  );
  for (const service of services) {
    const problem = problemsByService.get(service.name);
    if (problem) fail(problem);
    else ok(`${service.name} on ${describeBuild(service.build)}`);
  }
  if (config.commandWorker) {
    const worker = config.commandWorker;
    const runs = await canExecuteOnCommandWorker(
      {
        host: worker.host,
        port: worker.port,
        readToken: await prepareSecret(
          worker.token,
          "commandWorker.token",
          io.env,
        ),
      },
      worker.shell ?? "/bin/sh",
    );
    if (runs) ok(`command worker can run ${worker.shell ?? "/bin/sh"}`);
    else fail(`command worker cannot run ${worker.shell ?? "/bin/sh"}`);
  }
  if (problems.length > 0) {
    io.stdout(`Smoke check failed: ${problems.length} problem(s)\n`);
    return 1;
  }
  io.stdout(`Smoke check passed: ${describeBuild(SERVER_BUILD)}\n`);
  return 0;
}

/** "Audit checkpoints: ..." for `--check`, from the checkpointer's record. */
async function describeCheckpoints(
  config: AssistantServerConfig,
): Promise<string> {
  let state: Partial<CheckpointStatus>;
  try {
    state = JSON.parse(
      await fs.readFile(serverCheckpointStateFile(config), "utf8"),
    ) as Partial<CheckpointStatus>;
  } catch {
    return "Audit checkpoints: none yet (the first follows within an hour of the server starting)";
  }
  const last = state.lastCheckpoint;
  const failure = state.lastFailure;
  const parts = [
    last
      ? `last at entry ${last.seq}, ${new Date(last.at).toISOString()}`
      : "none yet",
  ];
  if (failure && (!last || failure.at > last.at)) {
    parts.push(
      `failing since ${new Date(failure.at).toISOString()} (${failure.error})`,
    );
  }
  const verification = state.lastVerification;
  if (verification && !verification.ok) {
    parts.push(
      `the log does NOT match them: ${verification.problems.join("; ")}`,
    );
  } else if (verification) {
    parts.push(`the log matched ${verification.checked} checkpoint(s)`);
  }
  return `Audit checkpoints: ${parts.join("; ")}`;
}

/**
 * Check the task audit log's hash chain, and with --checkpoints that it
 * still matches the signed checkpoints in the backup store; exit 1 when
 * either fails.
 */
async function runAuditCheck(
  config: AssistantServerConfig,
  io: AssistantServerCliIo,
  options: { readonly checkpoints?: boolean; readonly directory?: string } = {},
): Promise<number> {
  const directory = options.directory ?? serverAuditDirectory(config);
  const result = await verifyTaskAudit(directory);
  for (const damage of result.damaged) {
    io.stdout(
      `Earlier damage, found ${new Date(damage.at).toISOString()} and kept as ${damage.keptAs}: ${damage.problems.join("; ")}\n`,
    );
  }
  let failed = false;
  if (!result.ok) {
    io.stdout(
      `Audit log ${directory} is broken after ${result.entries} good entr${result.entries === 1 ? "y" : "ies"}: ${result.problems.join("; ")}\n`,
    );
    failed = true;
  } else {
    io.stdout(
      `Audit log OK: ${result.entries} entr${result.entries === 1 ? "y" : "ies"}, hash chain intact\n`,
    );
  }
  if (!options.checkpoints) return failed ? 1 : 0;
  if (!config.backup) {
    io.stdout(
      'Checkpoints: not configured (they are kept in the backup store; see "Backups" in the README)\n',
    );
    return 1;
  }
  const key = await loadCheckpointKey(checkpointKeyFile(config.dataRoot), {
    create: false,
  });
  if (!key) {
    io.stdout(
      "Checkpoints: this server has no signing key yet (it creates one when it starts with backups configured)\n",
    );
    return 1;
  }
  const client = createBackupClient({
    host: config.backup.host,
    port: config.backup.port,
    token: await prepareSecret(config.backup.token, "backup.token", io.env),
  });
  let checkpoints;
  try {
    checkpoints = await client.checkpoints();
  } catch (error) {
    io.stdout(
      `Checkpoints: could not read them from the backup store (${error instanceof BackupRequestError ? (error.detail ?? error.code) : error instanceof Error ? error.message : String(error)})\n`,
    );
    return 1;
  }
  const checked = verifyCheckpoints({
    hashes: await readAuditHashes(directory),
    checkpoints,
    publicKey: key.publicKey,
  });
  const rejected =
    checked.rejected > 0
      ? `; ignored ${checked.rejected} not signed by this server's key`
      : "";
  if (!checked.ok) {
    io.stdout(
      `Checkpoints: the log does NOT match the backup store's checkpoints: ${checked.problems.join("; ")}${rejected}\n`,
    );
    return 1;
  }
  io.stdout(
    checked.latest
      ? `Checkpoints OK: the log matches ${checked.checked} signed checkpoint(s) in the backup store, the latest at entry ${checked.latest.seq} (${new Date(checked.latest.at).toISOString()})${rejected}\n`
      : `Checkpoints: none in the backup store yet${rejected}\n`,
  );
  return failed ? 1 : 0;
}

async function runPair(
  config: AssistantServerConfig,
  io: AssistantServerCliIo,
): Promise<number> {
  const dataRoot = serverAccessDataRoot(config);
  let issued: { code: string; expiresAt: number };
  try {
    issued = await issueLocalPairingCode({ dataRoot });
  } catch (error) {
    if (
      error instanceof ServerAccessError &&
      error.code === "local_pairing_wrong_user"
    ) {
      io.log(
        `agentlink-server: run this as the account that owns ${dataRoot} (the service account), for example with sudo -u.`,
      );
      return 1;
    }
    throw error;
  }
  const link = pairingLink(config.publicOrigins[0]!, issued.code);
  // The code goes to this terminal only, never to the service log.
  io.stdout(
    [
      "Sign in to the AgentLink assistant",
      "",
      `  Pairing code:  ${issued.code.slice(0, 3)} ${issued.code.slice(3)}`,
      `  Sign-in link:  ${link}`,
      "",
      "Scan this with your phone's camera, or open the link (or the server",
      "address) on the device you want to sign in and enter the code:",
      "",
      terminalQrCode(link),
      "",
      `Single use; expires ${new Date(issued.expiresAt).toLocaleTimeString()}. Running`,
      "this again replaces the code. To add more devices later, open",
      `${config.publicOrigins[0]}/devices on a signed-in one.`,
      "",
    ].join("\n"),
  );
  return 0;
}

async function runExportCa(
  config: AssistantServerConfig,
  io: AssistantServerCliIo,
): Promise<number> {
  if (!usesLocalCa(config.tls)) {
    io.log(
      'agentlink-server: export-ca needs "tls": { "localCa": true }. With certificate files, distribute your own CA instead.',
    );
    return 1;
  }
  const authority = await readLocalCertificateAuthority({
    directory: serverTlsDirectory(config),
    hosts: localTlsHostsFromOrigins(config.publicOrigins),
  });
  if (!authority) {
    io.log(
      "agentlink-server: no local CA yet. Start the server once to create it.",
    );
    return 1;
  }
  // The PEM is public and goes to stdout for redirection; the fingerprint
  // goes to stderr so it stays on the terminal for comparison.
  io.stdout(authority.certificatePem);
  io.log(
    `CA SHA-256 fingerprint: ${authority.fingerprint256}\nCompare it with the fingerprint each device shows before trusting the certificate.`,
  );
  return 0;
}

async function runCodexLogin(
  config: AssistantServerConfig,
  io: AssistantServerCliIo,
): Promise<number> {
  if (!io.readLine) {
    io.log("agentlink-server: codex-login needs an interactive terminal");
    return 1;
  }
  const codex = createServerCodexRuntime(config, io.log);
  await codex.ready();
  const authorizeUrl = codex.manager.startAuthorizationFlow();
  io.stdout(
    [
      "Sign in with ChatGPT:",
      "",
      "1. Open this link in a browser on any device:",
      "",
      `   ${authorizeUrl}`,
      "",
      "2. After signing in, the browser goes to an http://localhost:1455/...",
      "   address that fails to load. That is expected.",
      "3. Copy that full address from the address bar and paste it here.",
      "",
      "Address: ",
    ].join("\n"),
  );
  const pasted = await io.readLine();
  if (!pasted?.trim()) {
    codex.manager.cancelAuthorizationFlow();
    io.log("agentlink-server: no address entered; sign-in cancelled");
    return 1;
  }
  let credentials;
  try {
    credentials = await codex.manager.completeAuthorizationFromRedirect(pasted);
  } catch (error) {
    io.log(
      `agentlink-server: sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  const saved = await codex.manager.saveOAuthAccount(credentials, {
    makeActive: true,
  });
  io.stdout(
    `\nSigned in as ${saved.account.label} (${saved.action}).\n${await describeCodexSignIn(codex)}\n`,
  );
  return 0;
}

async function runCodexLogout(
  config: AssistantServerConfig,
  io: AssistantServerCliIo,
): Promise<number> {
  const codex = createServerCodexRuntime(config, io.log);
  await codex.ready();
  await codex.manager.clearCredentials();
  io.stdout("Removed every stored ChatGPT sign-in.\n");
  return 0;
}

async function runCommandWorker(
  argv: readonly string[],
  io: AssistantServerCliIo,
): Promise<number> {
  let listen = DEFAULT_COMMAND_WORKER_LISTEN;
  let tokenFile: string | undefined;
  let allowLocalPeers = false;
  let reapOrphans = false;
  const roots: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const value = argv[index + 1];
    if (argument === "--help" || argument === "-h") {
      io.stdout(ASSISTANT_SERVER_USAGE);
      return 0;
    }
    if (argument === "--allow-local-peers") {
      allowLocalPeers = true;
      continue;
    }
    if (argument === "--reap-orphans") {
      reapOrphans = true;
      continue;
    }
    if (
      argument !== "--listen" &&
      argument !== "--token-file" &&
      argument !== "--root"
    ) {
      return usageError(io, `Unknown argument: ${argument}`);
    }
    if (!value) return usageError(io, `${argument} needs a value`);
    index += 1;
    if (argument === "--listen") listen = value;
    else if (argument === "--token-file") tokenFile = value;
    else roots.push(value);
  }
  if (!tokenFile) return usageError(io, "--token-file is required");
  if (roots.length === 0) return usageError(io, "--root is required");
  const address = parseListen(listen);
  if (!address) return usageError(io, "--listen must be <host>:<port>");
  const { host, port } = address;
  const token = await (
    await prepareSecret({ file: tokenFile }, "--token-file", io.env)
  )();
  const worker = await startCommandWorker({
    host,
    port,
    token,
    roots,
    allowLocalPeers,
    reapOrphans,
    log: io.log,
  });
  io.log(
    `AgentLink command worker listening on ${host}:${worker.port} for ${roots.join(", ")}`,
  );
  const signal = await io.waitForShutdown();
  io.log(`Received ${signal}; stopping running commands`);
  await worker.close();
  return 0;
}

async function runEgressGateway(
  argv: readonly string[],
  io: AssistantServerCliIo,
): Promise<number> {
  let listen = DEFAULT_EGRESS_GATEWAY_LISTEN;
  let defaults = true;
  let policyKeyFile = io.env.AGENTLINK_EGRESS_POLICY_KEY_FILE || undefined;
  const extra: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const value = argv[index + 1];
    if (argument === "--help" || argument === "-h") {
      io.stdout(ASSISTANT_SERVER_USAGE);
      return 0;
    }
    if (argument === "--no-default-allow") {
      defaults = false;
      continue;
    }
    if (
      argument !== "--listen" &&
      argument !== "--allow" &&
      argument !== "--policy-key-file"
    ) {
      return usageError(io, `Unknown argument: ${argument}`);
    }
    if (!value) return usageError(io, `${argument} needs a value`);
    index += 1;
    if (argument === "--listen") listen = value;
    else if (argument === "--policy-key-file") policyKeyFile = value;
    else extra.push(value);
  }
  const address = parseListen(listen);
  if (!address) return usageError(io, "--listen must be <host>:<port>");
  const fromEnv = (io.env.AGENTLINK_EGRESS_ALLOW ?? "")
    .split(/[\s,]+/u)
    .filter(Boolean);
  const allow = [
    ...(defaults ? DEFAULT_EGRESS_ALLOWLIST : []),
    ...extra,
    ...fromEnv,
  ];
  let entries: readonly string[];
  try {
    entries = parseEgressAllowlist(allow).entries;
  } catch (error) {
    return usageError(io, error instanceof Error ? error.message : "--allow");
  }
  if (entries.length === 0) {
    return usageError(io, "the allowlist is empty: add --allow <host>");
  }
  let policyKey: Buffer | undefined;
  if (policyKeyFile) {
    try {
      policyKey = parseNetworkPolicyKey(await fs.readFile(policyKeyFile));
    } catch (error) {
      return usageError(
        io,
        `--policy-key-file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const dependencies = parseEgressAllowlist(entries);
  const gateway = await startEgressGateway({
    host: address.host,
    port: address.port,
    allow: entries,
    log: io.log,
    ...(policyKey
      ? { authorize: egressPolicyAuthorizer(policyKey, dependencies) }
      : {}),
  });
  io.log(
    `AgentLink egress gateway listening on ${address.host}:${gateway.port}; allowing ${entries.join(", ")}${policyKey ? " (and per-project policies from the server)" : ""}`,
  );
  const signal = await io.waitForShutdown();
  io.log(`Received ${signal}; closing tunnels`);
  await gateway.close();
  return 0;
}

async function runPublisher(
  argv: readonly string[],
  io: AssistantServerCliIo,
): Promise<number> {
  const values: Record<string, string | undefined> = {
    "--listen": DEFAULT_PUBLISHER_LISTEN,
    "--client-id": io.env.AGENTLINK_GITHUB_CLIENT_ID || undefined,
  };
  const known = [
    "--listen",
    "--token-file",
    "--key-file",
    "--tasks-root",
    "--data",
    "--client-id",
  ];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      io.stdout(ASSISTANT_SERVER_USAGE);
      return 0;
    }
    if (!known.includes(argument)) {
      return usageError(io, `Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) return usageError(io, `${argument} needs a value`);
    values[argument] = value;
    index += 1;
  }
  for (const required of [
    "--token-file",
    "--key-file",
    "--tasks-root",
    "--data",
  ]) {
    if (!values[required]) return usageError(io, `${required} is required`);
  }
  const address = parseListen(values["--listen"]!);
  if (!address) return usageError(io, "--listen must be <host>:<port>");
  const clientId = values["--client-id"]?.trim() || undefined;
  if (clientId && !/^[A-Za-z0-9._-]{1,100}$/u.test(clientId)) {
    return usageError(io, "--client-id is not a GitHub App client ID");
  }
  const token = await (
    await prepareSecret(
      { file: values["--token-file"]! },
      "--token-file",
      io.env,
    )
  )();
  let vaultKey: Buffer;
  try {
    const readKey = await prepareSecret(
      { file: values["--key-file"]! },
      "--key-file",
      io.env,
    );
    vaultKey = parseVaultKey(Buffer.from(await readKey(), "utf8"));
  } catch (error) {
    return usageError(
      io,
      `--key-file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const publisher = await startPublisher({
    host: address.host,
    port: address.port,
    token,
    vaultKey,
    tasksRoot: values["--tasks-root"]!,
    dataDirectory: values["--data"]!,
    ...(clientId ? { clientId } : {}),
    log: io.log,
  });
  io.log(
    `AgentLink publisher listening on ${address.host}:${publisher.port} for ${values["--tasks-root"]}${clientId ? "; Connect GitHub uses the configured GitHub App" : "; no GitHub App client ID, so only pasted tokens can connect"}`,
  );
  const signal = await io.waitForShutdown();
  io.log(`Received ${signal}; stopping the publisher`);
  await publisher.close();
  return 0;
}

/**
 * A QR code for a terminal: two modules per character cell (upper half
 * block, foreground for the top module and background for the bottom), with
 * explicit colours so it scans on dark and light themes alike.
 */
export function terminalQrCode(text: string): string {
  const { data, size } = encode(text, { border: 2 });
  const dark = (row: number, column: number) =>
    row < size && data[row]![column] === true;
  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = "";
    for (let column = 0; column < size; column += 1) {
      const top = dark(row, column) ? 30 : 97;
      const bottom = dark(row + 1, column) ? 40 : 107;
      line += `\x1b[${top};${bottom}m\u2580`;
    }
    lines.push(`  ${line}\x1b[0m`);
  }
  return lines.join("\n");
}

/** Parse `--flag value` pairs, allowing only `known`. */
function parseFlags(
  argv: readonly string[],
  known: readonly string[],
  values: Record<string, string | undefined>,
): { readonly help: true } | { readonly error: string } | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!known.includes(argument)) {
      return { error: `Unknown argument: ${argument}` };
    }
    const value = argv[index + 1];
    if (!value) return { error: `${argument} needs a value` };
    values[argument] = value;
    index += 1;
  }
  return undefined;
}

/** `2g`, `512m`, `1024k` or bytes. */
function parseByteSize(value: string): number | undefined {
  const match = /^(\d+)([kmg]?)$/iu.exec(value.trim());
  if (!match) return undefined;
  const scale = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[
    match[2]!.toLowerCase() as "" | "k" | "m" | "g"
  ];
  return Number(match[1]) * scale;
}

async function runRunnerManager(
  argv: readonly string[],
  io: AssistantServerCliIo,
): Promise<number> {
  const values: Record<string, string | undefined> = {
    "--listen": `0.0.0.0:${RUNNER_MANAGER_PORT}`,
    "--docker-socket": "/var/run/docker.sock",
    "--user": "1000:1000",
    "--memory": "2g",
    "--cpus": "2",
    "--pids": "512",
  };
  const parsed = parseFlags(
    argv,
    [
      "--listen",
      "--token-file",
      "--image",
      "--network",
      "--projects-root",
      "--data-root",
      "--docker-socket",
      "--user",
      "--memory",
      "--cpus",
      "--pids",
      "--projects-host-root",
      "--data-host-root",
    ],
    values,
  );
  if (parsed && "help" in parsed) {
    io.stdout(ASSISTANT_SERVER_USAGE);
    return 0;
  }
  if (parsed) return usageError(io, parsed.error);
  for (const required of [
    "--token-file",
    "--image",
    "--network",
    "--projects-root",
    "--data-root",
  ]) {
    if (!values[required]) return usageError(io, `${required} is required`);
  }
  const address = parseListen(values["--listen"]!);
  if (!address) return usageError(io, "--listen must be <host>:<port>");
  if (!/^\d{1,10}:\d{1,10}$/u.test(values["--user"]!)) {
    return usageError(io, "--user must be <uid>:<gid>");
  }
  const memory = parseByteSize(values["--memory"]!);
  const cpus = Number(values["--cpus"]);
  const pids = Number(values["--pids"]);
  if (!memory || memory < 64 * 1024 ** 2) {
    return usageError(io, "--memory must be at least 64m");
  }
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 256) {
    return usageError(io, "--cpus must be a positive number");
  }
  if (!Number.isSafeInteger(pids) || pids < 16) {
    return usageError(io, "--pids must be an integer of at least 16");
  }
  const projectsHost = values["--projects-host-root"];
  const dataHost = values["--data-host-root"];
  if ((projectsHost === undefined) !== (dataHost === undefined)) {
    return usageError(
      io,
      "--projects-host-root and --data-host-root go together",
    );
  }
  const token = await (
    await prepareSecret(
      { file: values["--token-file"]! },
      "--token-file",
      io.env,
    )
  )();
  const manager = await startRunnerManager({
    host: address.host,
    port: address.port,
    token,
    dockerSocket: values["--docker-socket"]!,
    image: values["--image"]!,
    network: values["--network"]!,
    projectsRoot: values["--projects-root"]!,
    dataRoot: values["--data-root"]!,
    ...(projectsHost && dataHost
      ? { hostPaths: { projects: projectsHost, data: dataHost } }
      : {}),
    user: values["--user"]!,
    limits: { memory, cpus, pids },
    log: io.log,
  });
  io.log(
    `AgentLink runner manager listening on ${address.host}:${manager.port}; runners use ${values["--image"]} on ${values["--network"]}`,
  );
  const signal = await io.waitForShutdown();
  io.log(`Received ${signal}; stopping the runner manager`);
  await manager.close();
  return 0;
}

async function runSessionRunner(
  argv: readonly string[],
  io: AssistantServerCliIo,
): Promise<number> {
  const values: Record<string, string | undefined> = {
    "--listen": `0.0.0.0:${RUNNER_PORT}`,
    "--data": RUNNER_DATA_ROOT,
  };
  const parsed = parseFlags(argv, ["--listen", "--data"], values);
  if (parsed && "help" in parsed) {
    io.stdout(ASSISTANT_SERVER_USAGE);
    return 0;
  }
  if (parsed) return usageError(io, parsed.error);
  const address = parseListen(values["--listen"]!);
  if (!address) return usageError(io, "--listen must be <host>:<port>");
  const token = io.env[RUNNER_ENV.token];
  const controlUrl = io.env[RUNNER_ENV.controlUrl];
  const rawSpec = io.env[RUNNER_ENV.spec];
  if (!token || !controlUrl || !rawSpec) {
    return usageError(
      io,
      `${RUNNER_ENV.token}, ${RUNNER_ENV.controlUrl} and ${RUNNER_ENV.spec} must be set`,
    );
  }
  // Not inherited by anything this process starts.
  delete io.env[RUNNER_ENV.token];
  let spec: SessionRunnerSpec;
  try {
    spec = JSON.parse(rawSpec) as SessionRunnerSpec;
  } catch {
    return usageError(io, `${RUNNER_ENV.spec} is not JSON`);
  }
  const runner = await startSessionRunner({
    spec,
    token,
    controlUrl,
    dataRoot: values["--data"]!,
    host: address.host,
    port: address.port,
    log: io.log,
  });
  const signal = await io.waitForShutdown();
  io.log(`Received ${signal}; stopping the session runner`);
  await runner.close();
  return 0;
}

function parseListen(
  listen: string,
): { readonly host: string; readonly port: number } | undefined {
  const separator = listen.lastIndexOf(":");
  const host = listen.slice(0, separator);
  const port = Number(listen.slice(separator + 1));
  if (
    separator <= 0 ||
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    return undefined;
  }
  return { host, port };
}

function usageError(io: AssistantServerCliIo, problem: string): number {
  io.log(`agentlink-server: ${problem}\n\n${ASSISTANT_SERVER_USAGE}`);
  return 2;
}
