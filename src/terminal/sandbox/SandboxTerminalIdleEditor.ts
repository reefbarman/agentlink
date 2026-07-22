import { Buffer } from "node:buffer";

const MAX_IDLE_COMMAND_BYTES = 64 * 1024;
const MAX_COMMAND_HISTORY = 100;

export type SandboxTerminalIdleEditorAction =
  | { type: "write"; data: string }
  | { type: "submit"; command: string }
  | { type: "interrupt" };

export class SandboxTerminalIdleEditor {
  private value = "";
  private readonly history: string[] = [];
  private historyIndex = 0;

  reset(): void {
    this.value = "";
    this.historyIndex = this.history.length;
  }

  handle(data: string): SandboxTerminalIdleEditorAction[] {
    const actions: SandboxTerminalIdleEditorAction[] = [];
    for (let index = 0; index < data.length; index += 1) {
      const character = data[index];
      if (character === "\x03") {
        this.reset();
        actions.push({ type: "interrupt" }, { type: "write", data: "^C\r\n" });
        continue;
      }
      if (character === "\r" || character === "\n") {
        if (character === "\r" && data[index + 1] === "\n") index += 1;
        const command = this.value.trim();
        this.reset();
        actions.push({ type: "write", data: "\r\n" });
        if (command) {
          this.history.push(command);
          this.history.splice(
            0,
            Math.max(0, this.history.length - MAX_COMMAND_HISTORY),
          );
          this.historyIndex = this.history.length;
          actions.push({ type: "submit", command });
          break;
        }
        continue;
      }
      if (character === "\x7f" || character === "\b") {
        if (this.value) {
          const characters = [...this.value];
          characters.pop();
          this.value = characters.join("");
          actions.push({ type: "write", data: "\b \b" });
        }
        continue;
      }
      if (
        character === "\x1b" &&
        (data[index + 1] === "[" || data[index + 1] === "O") &&
        data[index + 2] !== undefined
      ) {
        const direction = data[index + 2];
        index += 2;
        if (direction === "A" || direction === "B") {
          const replacement = this.recall(direction === "A" ? -1 : 1);
          if (replacement !== undefined) {
            actions.push({
              type: "write",
              data: `\r\x1b[2K$ ${replacement}`,
            });
          }
        }
        continue;
      }
      if (character < " " || character === "\x7f") continue;
      const next = this.value + character;
      if (Buffer.byteLength(next, "utf8") > MAX_IDLE_COMMAND_BYTES) continue;
      this.value = next;
      this.historyIndex = this.history.length;
      actions.push({ type: "write", data: character });
    }
    return actions;
  }

  private recall(offset: -1 | 1): string | undefined {
    if (this.history.length === 0) return undefined;
    this.historyIndex = Math.max(
      0,
      Math.min(this.history.length, this.historyIndex + offset),
    );
    this.value = this.history[this.historyIndex] ?? "";
    return this.value;
  }
}
