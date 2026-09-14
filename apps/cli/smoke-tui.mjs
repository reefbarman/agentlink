import { mkdir, mkdtemp, rm } from "node:fs/promises";

import os from "node:os";
import path from "node:path";
import process from "node:process";
import pty from "node-pty";

const root = import.meta.dirname;
const entry = path.resolve(
  process.argv[2] ?? path.join(root, "dist", "agentlink.js"),
);
const noColor = process.argv.includes("--no-color");
const fixtureRoot = await mkdtemp(
  path.join(os.tmpdir(), "agentlink-tui-smoke-"),
);
const projectRoot = path.join(fixtureRoot, "project");
const dataRoot = path.join(fixtureRoot, "data");
await mkdir(projectRoot, { recursive: true });

try {
  const environment = {
    ...process.env,
    AGENTLINK_HOME: dataRoot,
    TERM: "xterm-256color",
  };
  delete environment.CI;
  if (noColor) {
    environment.NO_COLOR = "1";
    environment.FORCE_COLOR = "0";
  } else {
    delete environment.NO_COLOR;
    environment.FORCE_COLOR = "1";
  }
  const child = pty.spawn(process.execPath, [entry, "--project", projectRoot], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: projectRoot,
    env: environment,
  });
  let output = "";
  let started = false;
  let exited = false;
  const exit = new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    const rejectAndKill = (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      forceKillPty(child);
      reject(error);
    };
    timeout = setTimeout(
      () =>
        rejectAndKill(
          new Error(`TUI smoke timed out\n${output.slice(-4_000)}`),
        ),
      20_000,
    );
    child.onData((chunk) => {
      output += chunk;
      if (
        !started &&
        output.includes("What would you like AgentLink to work on?")
      ) {
        started = true;
        void exerciseTui(child, () => output).catch(rejectAndKill);
      }
    });
    child.onExit(({ exitCode, signal }) => {
      exited = true;
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve({ exitCode, signal });
    });
  });
  let result;
  try {
    result = await exit;
  } finally {
    if (!exited) forceKillPty(child);
  }
  if (result.exitCode !== 0 || result.signal !== 0) {
    throw new Error(
      `TUI exited with ${result.exitCode} (signal ${result.signal})\n${output.slice(-4_000)}`,
    );
  }
  for (const expected of [
    "AgentLink",
    "What would you like AgentLink to work on?",
    "Choose an action. All controls are also available from slash commands.",
    "\u001b[?1049h",
    "\u001b[?1049l",
  ]) {
    if (!output.includes(expected)) {
      throw new Error(`TUI smoke output omitted ${JSON.stringify(expected)}`);
    }
  }
  const alternateEntries = output.split("\u001b[?1049h").length - 1;
  const alternateExits = output.split("\u001b[?1049l").length - 1;
  if (alternateEntries < 2 || alternateExits < 2) {
    throw new Error(
      `TUI suspend/resume did not cycle alternate-screen state (${alternateEntries} enter, ${alternateExits} exit)`,
    );
  }
  const hasForegroundColor =
    /\u001b\[(?:3[0-7]|9[0-7]|38;(?:5;\d+|2;\d+;\d+;\d+))m/u.test(output);
  if (noColor ? hasForegroundColor : !hasForegroundColor) {
    throw new Error(
      noColor
        ? "NO_COLOR TUI emitted foreground colour escapes"
        : "Colour TUI omitted foreground colour escapes",
    );
  }
  process.stdout.write(
    `Ink TUI ${noColor ? "no-colour " : ""}launch, rapid resize, input, controls, suspend/resume, signal exit, and restoration passed\n`,
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function exerciseTui(child, readOutput) {
  await delay(250);
  for (const [columns, rows] of [
    [52, 18],
    [120, 40],
    [42, 16],
    [78, 24],
  ]) {
    child.resize(columns, rows);
  }
  await delay(100);
  child.write("\u000f");
  await waitForOutput(
    readOutput,
    "Choose an action. All controls are also available from slash commands.",
  );
  child.write("\u001b");
  await delay(150);
  child.write("\u001a");
  await delay(200);
  process.kill(child.pid, "SIGCONT");
  await delay(250);
  child.write("\u0003");
}

function forceKillPty(child) {
  try {
    process.kill(child.pid, "SIGCONT");
  } catch {}
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {}
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForOutput(readOutput, expected) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (readOutput().includes(expected)) return;
    await delay(25);
  }
  throw new Error(
    `TUI smoke did not reach ${JSON.stringify(expected)}\n${readOutput().slice(-4_000)}`,
  );
}
