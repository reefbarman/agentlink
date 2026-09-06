import { createServer } from "node:net";
import electronPath from "electron";
import { spawn } from "node:child_process";

async function findAvailableLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!port) throw new Error("desktop_dev_port_unavailable");
  return port;
}

const env = { ...process.env };
env.AGENTLINK_BROWSER_GATEWAY_DISCOVERY_NAMESPACE ??= `desktop-dev-${process.pid}`;
env.AGENTLINK_DESKTOP_HELPER_PORT ??= String(await findAvailableLoopbackPort());
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ["."], {
  cwd: new URL(".", import.meta.url),
  env,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(
    `[agentlink-desktop] failed to launch Electron: ${String(error)}`,
  );
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
