import { runAssistantServerCli } from "./serverCli.js";

const log = (line: string) => {
  process.stderr.write(`${line}\n`);
};

let shuttingDown = false;
const waitForShutdown = () =>
  new Promise<string>((resolve) => {
    const onSignal = (signal: NodeJS.Signals) => {
      if (shuttingDown) {
        // A second signal skips the graceful wait.
        log(`Received ${signal} again; exiting immediately`);
        process.exit(1);
      }
      shuttingDown = true;
      resolve(signal);
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  });

try {
  process.exitCode = await runAssistantServerCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    log,
    env: process.env,
    waitForShutdown,
  });
} catch (error) {
  log(
    `agentlink-server: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
// Lingering handles (for example a provider keep-alive socket) must not keep
// a stopped service alive under systemd or launchd.
process.exit();
