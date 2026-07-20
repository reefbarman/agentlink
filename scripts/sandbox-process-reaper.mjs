import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";

const MAX_CONTROL_BYTES = 1024 * 1024;
const FORCE_KILL_DELAY_MS = 500;

function writeStatus(value) {
  try {
    writeSync(3, `${JSON.stringify(value)}\n`);
  } catch (error) {
    if (error?.code !== "EPIPE" && error?.code !== "EBADF") {
      throw error;
    }
  }
}

function terminateProcessGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessGroupExit(pgid) {
  while (processGroupExists(pgid)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function parseLaunch(source) {
  if (Buffer.byteLength(source) > MAX_CONTROL_BYTES) {
    throw new Error("reaper launch request is too large");
  }
  const request = JSON.parse(source);
  if (
    request === null ||
    typeof request !== "object" ||
    typeof request.token !== "string" ||
    request.token.length < 32 ||
    !Array.isArray(request.argv) ||
    request.argv.length === 0 ||
    request.argv.some((value) => typeof value !== "string") ||
    typeof request.cwd !== "string" ||
    request.environment === null ||
    typeof request.environment !== "object" ||
    Array.isArray(request.environment) ||
    Object.values(request.environment).some(
      (value) => typeof value !== "string",
    )
  ) {
    throw new Error("invalid reaper launch request");
  }
  return request;
}

async function main() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) {
    throw new Error("reaper launch pipe closed before a request arrived");
  }
  const request = parseLaunch(first.value);
  const child = spawn(request.argv[0], request.argv.slice(1), {
    cwd: request.cwd,
    env: request.environment,
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid === undefined) {
    throw new Error("reaper could not identify the sandbox process group");
  }
  const pgid = child.pid;
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  let forceKillTimer;
  let terminationStarted = false;
  const terminate = (signal = "SIGTERM") => {
    terminateProcessGroup(pgid, signal);
    if (!terminationStarted) {
      terminationStarted = true;
      forceKillTimer = setTimeout(
        () => terminateProcessGroup(pgid, "SIGKILL"),
        FORCE_KILL_DELAY_MS,
      );
      forceKillTimer.unref();
    }
  };

  const childOutcome = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      writeStatus({
        kind: "error",
        token: request.token,
        error: error instanceof Error ? error.message : String(error),
      });
      reject(error);
    });
    child.once("exit", (exitCode, signal) => {
      terminate();
      resolve({ exitCode, signal });
    });
  });
  child.once("spawn", () => {
    writeStatus({
      kind: "launched",
      token: request.token,
      pid: child.pid,
      pgid,
    });
  });

  const controls = (async () => {
    for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
      if (Buffer.byteLength(line) > MAX_CONTROL_BYTES) {
        terminate("SIGKILL");
        continue;
      }
      let control;
      try {
        control = JSON.parse(line);
      } catch {
        continue;
      }
      if (control?.token !== request.token) {
        continue;
      }
      if (control.operation === "terminate") {
        terminate(control.signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
      }
    }
    terminate();
  })();

  const outcome = await childOutcome;
  await waitForProcessGroupExit(pgid);
  clearTimeout(forceKillTimer);
  writeStatus({ kind: "closed", token: request.token, ...outcome });
  await controls;
  lines.close();
}

try {
  await main();
} catch (error) {
  writeStatus({
    kind: "error",
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
