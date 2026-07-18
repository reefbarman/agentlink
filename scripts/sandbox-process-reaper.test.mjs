import { spawn, spawnSync } from "node:child_process";

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REAPER_PATH = path.join(SCRIPT_DIR, "sandbox-process-reaper.mjs");
const OWNER_PATH = path.join(SCRIPT_DIR, "sandbox-process-reaper-owner.mjs");
const darwinTest = process.platform === "darwin" ? test : test.skip;

function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessGroupExit(pgid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pgid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processGroupExists(pgid);
}

function waitForJsonLine(stream, predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for JSON status"));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          return;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const value = JSON.parse(line);
        if (predicate(value)) {
          cleanup();
          resolve(value);
          return;
        }
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("status stream closed before expected JSON arrived"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("close", onClose);
    };
    stream.on("data", onData);
    stream.once("close", onClose);
  });
}

function waitForClose(child, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("process did not exit"));
    }, timeoutMs);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal });
    });
  });
}

darwinTest(
  "reaper reports a fast child exit without missing events",
  async () => {
    const token = "f".repeat(64);
    const reaper = spawn(process.execPath, [REAPER_PATH], {
      stdio: ["pipe", "ignore", "ignore", "pipe"],
    });
    const launchedPromise = waitForJsonLine(
      reaper.stdio[3],
      (status) => status.kind === "launched",
    );
    const closedPromise = waitForJsonLine(
      reaper.stdio[3],
      (status) => status.kind === "closed",
    );
    reaper.stdin.write(
      `${JSON.stringify({
        token,
        argv: ["/usr/bin/true"],
        cwd: SCRIPT_DIR,
        environment: { PATH: "/usr/bin:/bin" },
      })}\n`,
    );
    const [launched, closed] = await Promise.all([
      launchedPromise,
      closedPromise,
    ]);
    assert.equal(launched.pid, launched.pgid);
    assert.equal(closed.token, token);
    assert.equal(closed.exitCode, 0);
    reaper.stdin.end();
    await waitForClose(reaper);
    assert.equal(await waitForProcessGroupExit(launched.pgid), true);
  },
);

darwinTest(
  "reaper owns and terminates its verified detached process group",
  async () => {
    const token = "a".repeat(64);
    const reaper = spawn(process.execPath, [REAPER_PATH], {
      stdio: ["pipe", "ignore", "ignore", "pipe"],
    });
    const launchedPromise = waitForJsonLine(
      reaper.stdio[3],
      (status) => status.kind === "launched",
    );
    reaper.stdin.write(
      `${JSON.stringify({
        token,
        argv: ["/bin/bash", "-c", "while :; do sleep 1; done"],
        cwd: SCRIPT_DIR,
        environment: { PATH: "/usr/bin:/bin" },
      })}\n`,
    );
    const launched = await launchedPromise;
    assert.equal(launched.token, token);
    assert.equal(launched.pid, launched.pgid);
    assert.equal(processGroupExists(launched.pgid), true);

    const closedPromise = waitForJsonLine(
      reaper.stdio[3],
      (status) => status.kind === "closed",
    );
    reaper.stdin.write(
      `${JSON.stringify({ operation: "terminate", signal: "SIGTERM", token })}\n`,
    );
    const closed = await closedPromise;
    assert.equal(closed.token, token);
    reaper.stdin.end();
    await waitForClose(reaper);
    assert.equal(await waitForProcessGroupExit(launched.pgid), true);
  },
);

darwinTest(
  "reaper removes the process group after its owner is SIGKILLed",
  async () => {
    const owner = spawn(process.execPath, [OWNER_PATH], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launched = await waitForJsonLine(
      owner.stdout,
      (status) => status.kind === "launched",
    );
    assert.equal(launched.pid, launched.pgid);
    assert.equal(processGroupExists(launched.pgid), true);
    owner.kill("SIGKILL");
    await waitForClose(owner);
    const exited = await waitForProcessGroupExit(launched.pgid);
    if (!exited) {
      spawnSync("/bin/kill", ["-KILL", `-${launched.pgid}`]);
    }
    assert.equal(exited, true);
  },
);
