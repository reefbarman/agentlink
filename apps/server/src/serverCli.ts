import {
  preflightAssistantService,
  startAssistantService,
  type AssistantService,
} from "./assistantService.js";
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

Runs the AgentLink assistant server over HTTPS.

Options:
  --config <file>  Server configuration (JSON). Required.
  --check          Validate the configuration, TLS files, project
                   directories, and provider secrets, then exit.
  --help           Show this help.
`;

/** Returns the process exit code. */
export async function runAssistantServerCli(
  argv: readonly string[],
  io: AssistantServerCliIo,
): Promise<number> {
  let configPath: string | undefined;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      io.stdout(ASSISTANT_SERVER_USAGE);
      return 0;
    }
    if (argument === "--check") {
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

function usageError(io: AssistantServerCliIo, problem: string): number {
  io.log(`agentlink-server: ${problem}\n\n${ASSISTANT_SERVER_USAGE}`);
  return 2;
}
