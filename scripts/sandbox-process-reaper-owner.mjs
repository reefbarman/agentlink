import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const reaperPath = fileURLToPath(
  new URL("./sandbox-process-reaper.mjs", import.meta.url),
);
const token = randomBytes(32).toString("hex");
const reaper = spawn(process.execPath, [reaperPath], {
  stdio: ["pipe", "ignore", "ignore", "pipe"],
});
let buffer = "";
reaper.stdio[3].setEncoding("utf8");
reaper.stdio[3].on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) {
      break;
    }
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const status = JSON.parse(line);
    if (status.token === token && status.kind === "launched") {
      process.stdout.write(`${JSON.stringify(status)}\n`);
    }
  }
});
reaper.stdin.write(
  `${JSON.stringify({
    token,
    argv: ["/bin/bash", "-c", "while :; do sleep 1; done"],
    cwd: path.dirname(reaperPath),
    environment: { PATH: "/usr/bin:/bin" },
  })}\n`,
);
setInterval(() => {}, 60_000);
