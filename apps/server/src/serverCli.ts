import {
  preflightAssistantService,
  serverAccessDataRoot,
  startAssistantService,
  type AssistantService,
} from "./assistantService.js";
import {
  issueLocalRecoveryCredential,
  ServerAccessError,
} from "./ServerAccessStore.js";
import { loadAssistantServerConfig } from "./serverConfig.js";

export interface AssistantServerCliIo {
  /** Command output (help, check results). */
  readonly stdout: (text: string) => void;
  /** Operator log and errors. Under a service manager this is the journal. */
  readonly log: (line: string) => void;
  readonly env: NodeJS.ProcessEnv;
  /** Resolves with the signal name when the process should stop. */
  readonly waitForShutdown: () => Promise<string>;
  /** Observes the running service; used by tests. */
  readonly onStarted?: (service: AssistantService) => void;
}

export const ASSISTANT_SERVER_USAGE = `Usage: agentlink-server --config <file> [--check]
       agentlink-server recover --config <file>

Runs the AgentLink assistant server over HTTPS.

Options:
  --config <file>  Server configuration (JSON). Required.
  --check          Validate the configuration, TLS files, project
                   directories, and provider secrets, then exit.
  --help           Show this help.

Commands:
  recover          Print a single-use recovery code (15 minutes) for
                   signing in again when every browser session is lost.
                   Run it on the server machine as the service account.
                   It works whether or not the server is running.
`;

/** Returns the process exit code. */
export async function runAssistantServerCli(
  argv: readonly string[],
  io: AssistantServerCliIo,
): Promise<number> {
  const recover = argv[0] === "recover";
  let configPath: string | undefined;
  let check = false;
  for (let index = recover ? 1 : 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      io.stdout(ASSISTANT_SERVER_USAGE);
      return 0;
    }
    if (argument === "--check" && !recover) {
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
  if (!configPath) return usageError(io, "--config is required");

  const config = await loadAssistantServerConfig(configPath);
  if (recover) return await runRecover(serverAccessDataRoot(config), io);
  if (check) {
    await preflightAssistantService(config, io.env);
    io.stdout(
      `Configuration OK: ${config.projects.length} project(s), listening on ${config.listen.host}:${config.listen.port} for ${config.publicOrigins.join(", ")}\n`,
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

function usageError(io: AssistantServerCliIo, problem: string): number {
  io.log(`agentlink-server: ${problem}\n\n${ASSISTANT_SERVER_USAGE}`);
  return 2;
}
