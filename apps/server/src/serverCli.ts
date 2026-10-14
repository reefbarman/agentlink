import {
  preflightAssistantService,
  serverAccessDataRoot,
  serverTlsDirectory,
  startAssistantService,
  type AssistantService,
} from "./assistantService.js";
import { startCommandWorker } from "./commandWorker.js";
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
       agentlink-server command-worker --token-file <file> --root <dir>...
                                       [--listen <host:port>]
                                       [--allow-local-peers] [--reap-orphans]
       agentlink-server egress-gateway [--listen <host:port>]
                                       [--allow <host>]... [--no-default-allow]
                                       [--policy-key-file <path>]
       agentlink-server publisher --token-file <file> --key-file <file>
                                  --tasks-root <dir> --data <dir>
                                  [--client-id <id>] [--listen <host:port>]

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
`;

const DEFAULT_COMMAND_WORKER_LISTEN = "0.0.0.0:7300";
const DEFAULT_EGRESS_GATEWAY_LISTEN = "0.0.0.0:3128";
const DEFAULT_PUBLISHER_LISTEN = "0.0.0.0:7400";

const COMMANDS = new Set(["pair", "export-ca", "codex-login", "codex-logout"]);

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
  if (command === "pair") return await runPair(config, io);
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
    if (preflight.publisher) io.stdout(`${preflight.publisher}\n`);
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
