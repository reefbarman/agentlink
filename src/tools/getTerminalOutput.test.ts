import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalProvider } from "../core/capabilities/terminal.js";
import { handleGetTerminalOutput } from "./getTerminalOutput.js";

const terminalProvider: TerminalProvider = {
  executeCommand: vi.fn(),
  getBackgroundState: vi.fn(),
  interruptTerminal: vi.fn(),
  getRecentlyClosedTerminals: vi.fn(),
  listTerminals: vi.fn(),
  closeTerminals: vi.fn(),
};

function textPayload(result: {
  content: Array<{ type: string; text?: string }>;
}) {
  const textItem = result.content[0];
  expect(textItem.type).toBe("text");
  if (textItem.type !== "text" || typeof textItem.text !== "string") {
    throw new Error("Expected text result");
  }
  return JSON.parse(textItem.text);
}

describe("handleGetTerminalOutput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(terminalProvider.getRecentlyClosedTerminals).mockReturnValue([]);
  });

  it("returns an explicit unavailable result when no terminal provider is supplied", async () => {
    const result = await handleGetTerminalOutput({ terminal_id: "term_42" });

    expect(textPayload(result)).toEqual({
      error:
        "Terminal output is unavailable in this runtime. Provide a TerminalProvider to enable get_terminal_output.",
      terminal_id: "term_42",
    });
  });

  it("returns terminal recovery metadata when terminal id is missing", async () => {
    vi.mocked(terminalProvider.getBackgroundState).mockReturnValue(undefined);
    vi.mocked(terminalProvider.getRecentlyClosedTerminals).mockReturnValue([
      { id: "term_5", name: "snapshot-run", closedAt: Date.now() - 1000 },
    ]);

    const result = await handleGetTerminalOutput(
      { terminal_id: "term_42" },
      { terminalProvider },
    );
    const payload = textPayload(result);

    expect(payload.error).toContain('Terminal "term_42" not found');
    expect(payload.hint).toContain("terminal_name");
    expect(payload.recently_closed_terminals).toHaveLength(1);
    expect(payload.recently_closed_terminals[0].terminal_id).toBe("term_5");
    expect(payload.recently_closed_terminals[0].terminal_name).toBe(
      "snapshot-run",
    );
  });

  it("returns verification_hint when output capture is unavailable", async () => {
    vi.mocked(terminalProvider.getBackgroundState).mockReturnValue({
      is_running: true,
      exit_code: null,
      output: "",
      output_captured: false,
    });

    const result = await handleGetTerminalOutput(
      { terminal_id: "term_42" },
      { terminalProvider },
    );
    const payload = textPayload(result);

    expect(payload.output_captured).toBe(false);
    expect(payload.output).toContain("Output capture unavailable");
    expect(payload.verification_hint).toContain("term_42");
    expect(payload.verification_hint).toContain("rather than re-running it");
  });

  it("interrupts the terminal when kill is requested", async () => {
    vi.mocked(terminalProvider.getBackgroundState).mockReturnValue({
      is_running: false,
      exit_code: 130,
      output: "stopped",
      output_captured: true,
    });

    const result = await handleGetTerminalOutput(
      { terminal_id: "term_42", kill: true },
      { terminalProvider },
    );

    expect(terminalProvider.interruptTerminal).toHaveBeenCalledWith("term_42");
    expect(textPayload(result)).toMatchObject({
      killed: true,
      output: "stopped",
    });
  });
});
