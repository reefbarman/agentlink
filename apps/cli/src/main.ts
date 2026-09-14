import { emitKeypressEvents } from "node:readline";

import { openExternal, runCli, type CliIo } from "./cli.js";

let secretInputRaw = false;

function restoreTerminal(): void {
  if (!secretInputRaw || !process.stdin.isTTY) return;
  secretInputRaw = false;
  process.stdin.setRawMode(false);
}

process.once("exit", restoreTerminal);

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Secret input requires an interactive terminal");
  }
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  secretInputRaw = true;
  process.stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      restoreTerminal();
      process.stdin.pause();
      process.stdin.off("keypress", onKeypress);
      process.stdout.write("\n");
    };
    const onKeypress = (
      character: string,
      key: { name?: string; ctrl?: boolean },
    ) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Secret input cancelled"));
      } else if (key.name === "return") {
        cleanup();
        resolve(value);
      } else if (key.name === "backspace") {
        value = value.slice(0, -1);
      } else if (character && !key.ctrl) {
        value += character;
      }
    };
    process.stdin.on("keypress", onKeypress);
  });
}

const io: CliIo = {
  input: process.stdin,
  output: process.stdout,
  error: process.stderr,
  isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  readSecret,
  openExternal,
};

try {
  process.exitCode = await runCli(process.argv.slice(2), io);
} catch (error) {
  process.stderr.write(
    `agentlink: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
