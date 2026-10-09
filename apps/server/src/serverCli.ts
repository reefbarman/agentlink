import {
  preflightAssistantService,
  serverAccessDataRoot,
  serverTlsDirectory,
  startAssistantService,
  type AssistantService,
} from "./assistantService.js";
import { startCommandWorker } from "./commandWorker.js";
import {
  localTlsHostsFromOrigins,
  readLocalCertificateAuthority,
} from "./localCertificateAuthority.js";
import {
  createServerCodexRuntime,
  describeCodexSignIn,
  hasCodexProvider,
} from "./codexSignIn.js";
import {
  issueLocalRecoveryCredential,
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
       agentlink-server recover --config <file>
       agentlink-server export-ca --config <file> > agentlink-ca.pem
       agentlink-server codex-login --config <file>
       agentlink-server codex-logout --config <file>
       agentlink-server command-worker --token-file <file> --root <dir>...
                                       [--listen <host:port>]
                                       [--allow-local-peers] [--reap-orphans]

Runs the AgentLink assistant server over HTTPS.

Options:
  --config <file>  Server configuration (JSON). Required unless the
                   AGENTLINK_SERVER_CONFIG environment variable is set
                   (the container image sets it).
  --check          Validate the configuration, TLS files, project
                   directories, and provider secrets, then exit.
  --help           Show this help.

Commands:
  recover          Print a single-use recovery code (15 minutes) for
                   signing in again when every browser session is lost.
                   Run it on the server machine as the service account.
                   It works whether or not the server is running.
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
`;

const DEFAULT_COMMAND_WORKER_LISTEN = "0.0.0.0:7300";

const COMMANDS = new Set([
  "recover",
  "export-ca",
  "codex-login",
  "codex-logout",
]);

/** Returns the process exit code. */
export async function runAssistantServerCli(
  argv: readonly string[],
  io: AssistantServerCliIo,
): Promise<number> {
  if (argv[0] === "command-worker") {
    return await runCommandWorker(argv.slice(1), io);
  }
  const command = argv[0] && COMMANDS.has(argv[0]) ? argv[0] : undefined;
  let configPath: string | undefined;
  let check = false;
  for (let index = command ? 1 : 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      io.stdout(ASSISTANT_SERVER_USAGE);
      return 0;
    }
    if (argument === "--check" && !command) {
      check = true;
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
  if (command === "recover") {
    return await runRecover(serverAccessDataRoot(config), io);
  }
  if (command === "export-ca") return await runExportCa(config, io);
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

async function runRecover(
  dataRoot: string,
  io: AssistantServerCliIo,
): Promise<number> {
  let issued: { token: string; expiresAt: number };
  try {
    issued = await issueLocalRecoveryCredential({ dataRoot });
  } catch (error) {
    if (!(error instanceof ServerAccessError)) throw error;
    const problems: Partial<Record<string, string>> = {
      owner_missing:
        "No owner exists yet. Use the setup credential the server prints when it starts.",
      recovery_wrong_user: `Run this as the account that owns ${dataRoot} (the service account), for example with sudo -u.`,
      access_state_corrupt: `The access state in ${dataRoot} is unreadable. Recovery is refused rather than guessing.`,
    };
    io.log(`agentlink-server: ${problems[error.code] ?? error.code}`);
    return 1;
  }
  // The code goes to this terminal only, never to the service log.
  io.stdout(
    [
      "AgentLink recovery code (single use, expires " +
        `${new Date(issued.expiresAt).toISOString()}):`,
      "",
      `  ${issued.token}`,
      "",
      "Redeem it from the browser you want to sign in with, together with",
      "the owner passphrase (POST /api/auth/recover). Running this command",
      "again replaces the code.",
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
  const separator = listen.lastIndexOf(":");
  const host = listen.slice(0, separator);
  const port = Number(listen.slice(separator + 1));
  if (
    separator <= 0 ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return usageError(io, "--listen must be <host>:<port>");
  }
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

function usageError(io: AssistantServerCliIo, problem: string): number {
  io.log(`agentlink-server: ${problem}\n\n${ASSISTANT_SERVER_USAGE}`);
  return 2;
}
