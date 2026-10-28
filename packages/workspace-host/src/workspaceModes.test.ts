import { describe, expect, it } from "vitest";
import {
  isToolAllowedInWorkspaceMode,
  latestModeInstructionBlock,
  readModeInstructionBlock,
  stripModeInstructionBlock,
  workspaceModeAllowsWrites,
  workspaceModeRunsReadOnlyCommands,
  workspaceToolsForMode,
} from "./workspaceModes.js";

import { BUILT_IN_MODES } from "@agentlink/core/agent-modes";
import { formatModeInstructionBlock } from "@agentlink/core/system-prompt";

const mode = (slug: string) =>
  BUILT_IN_MODES.find((candidate) => candidate.slug === slug)!;

describe("workspace modes", () => {
  it("follows VS Code's tool groups with this host's own tool names", () => {
    const code = workspaceToolsForMode(mode("code"));
    for (const tool of [
      "write_file",
      "execute_command",
      "get_terminal_output",
      "close_terminals",
      "call_mcp_tool",
    ]) {
      expect(code.has(tool), tool).toBe(true);
    }
    // Architect plans with VS Code's plan group: output, but no close.
    const architect = workspaceToolsForMode(mode("architect"));
    expect(architect.has("get_terminal_output")).toBe(true);
    expect(architect.has("close_terminals")).toBe(false);
    const ask = workspaceToolsForMode(mode("ask"));
    // Ask runs commands under VS Code's read-only policy.
    expect(ask.has("execute_command")).toBe(true);
    expect(ask.has("get_terminal_output")).toBe(false);
    expect(workspaceModeRunsReadOnlyCommands(mode("ask"))).toBe(true);
    expect(workspaceModeRunsReadOnlyCommands(mode("code"))).toBe(false);
    expect(ask.has("read_file")).toBe(true);
    expect(isToolAllowedInWorkspaceMode("write_file", ask)).toBe(false);
    // Tools in no group work in every mode.
    expect(isToolAllowedInWorkspaceMode("ask_user", ask)).toBe(true);
    expect(isToolAllowedInWorkspaceMode("todo_write", ask)).toBe(true);
    // Review keeps VS Code's groups but not its temporary-file write_file.
    expect(workspaceToolsForMode(mode("review")).has("write_file")).toBe(false);
    expect(workspaceModeAllowsWrites(mode("architect"))).toBe(true);
    expect(workspaceModeAllowsWrites(mode("ask"))).toBe(false);
  });

  it("reads and strips the leading mode block of a message", () => {
    const block = formatModeInstructionBlock("ask");
    const text = `${block}\n\nWhat does this do?`;
    expect(readModeInstructionBlock(text)).toBe(block);
    expect(stripModeInstructionBlock(text)).toBe("What does this do?");
    expect(stripModeInstructionBlock("plain")).toBe("plain");
    expect(
      latestModeInstructionBlock([
        { role: "user", content: `${formatModeInstructionBlock("code")}\n\nA` },
        { role: "assistant", content: "ok" },
        { role: "user", content: [{ type: "text", text }] },
        { role: "user", content: "B" },
      ]),
    ).toBe(block);
  });
});
