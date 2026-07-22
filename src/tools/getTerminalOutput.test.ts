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
    terminalProvider.getRetainedOutput = undefined;
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
      {
        id: "term_5",
        name: "snapshot-run",
        closedAt: Date.now() - 1000,
        is_running: false,
        state: "unknown_termination",
        exit_code: null,
        output: "",
        output_captured: false,
      },
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

  it("retrieves retained output and status after the terminal closes", async () => {
    const closedAt = Date.now() - 1000;
    vi.mocked(terminalProvider.getBackgroundState).mockReturnValue(undefined);
    vi.mocked(terminalProvider.getRecentlyClosedTerminals).mockReturnValue([
      {
        id: "term_closed",
        name: "completed-run",
        closedAt,
        is_running: false,
        state: "completed",
        exit_code: 7,
        output: "one\npartial output before close\nthree",
        output_captured: true,
      },
    ]);

    const result = await handleGetTerminalOutput(
      { terminal_id: "term_closed", output_grep: "partial" },
      { terminalProvider },
    );

    expect(textPayload(result)).toMatchObject({
      terminal_id: "term_closed",
      terminal_name: "completed-run",
      closed_at: new Date(closedAt).toISOString(),
      recently_closed: true,
      is_running: false,
      state: "completed",
      exit_code: 7,
      output: "partial output before close",
      output_captured: true,
    });
  });

  it("returns verification_hint when output capture is unavailable", async () => {
    vi.mocked(terminalProvider.getBackgroundState).mockReturnValue({
      is_running: true,
      state: "running",
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

  it("omits duplicate terminal raw output from the model-facing result", async () => {
    vi.mocked(terminalProvider.getBackgroundState).mockReturnValue({
      is_running: false,
      state: "completed",
      exit_code: 0,
      output: "one\ntwo\nthree",
      terminal_raw_output:
        "\u001b[31mone\u001b[0m\n\u001b[32mtwo\u001b[0m\n\u001b[33mthree\u001b[0m",
      output_captured: true,
    });

    const result = await handleGetTerminalOutput(
      { terminal_id: "term_42", output_tail: 2 },
      { terminalProvider },
    );
    const payload = textPayload(result);

    expect(payload.output).toBe("two\nthree");
    expect(payload.terminal_raw_output).toBeUndefined();
  });

  it("filters exact retained output and saves a truthful full-output file", async () => {
    vi.mocked(terminalProvider.getBackgroundState).mockReturnValue({
      is_running: false,
      state: "completed",
      exit_code: 0,
      output: "tail-2\ntail-3",
      output_captured: true,
      output_complete: false,
    });
    terminalProvider.getRetainedOutput = vi.fn(() => ({
      output: "head-1\ntail-2\ntail-3",
      complete: true,
      finalized: true,
      total_bytes: 20,
      retained_bytes: 20,
      dropped_bytes: 0,
    }));

    const result = await handleGetTerminalOutput(
      { terminal_id: "term_42", output_tail: 1 },
      { terminalProvider },
    );
    const payload = textPayload(result);

    expect(payload).toMatchObject({
      output: "tail-3",
      output_complete: true,
      output_finalized: true,
      output_total_bytes: 20,
      output_retained_bytes: 20,
      output_dropped_bytes: 0,
      total_lines: 3,
      lines_shown: 1,
      output_file: expect.any(String),
    });
    expect(payload.output_warning).toContain("Full output saved");
  });

  it("does not publish a final output file while the command is still running", async () => {
    vi.mocked(terminalProvider.getBackgroundState).mockReturnValue({
      is_running: true,
      state: "running",
      exit_code: null,
      output: "one\ntwo\nthree",
      output_captured: true,
    });
    terminalProvider.getRetainedOutput = vi.fn(() => ({
      output: "one\ntwo\nthree",
      complete: false,
      finalized: false,
      total_bytes: 13,
      retained_bytes: 13,
      dropped_bytes: 0,
    }));

    const result = await handleGetTerminalOutput(
      { terminal_id: "term_42", output_tail: 1 },
      { terminalProvider },
    );
    const payload = textPayload(result);

    expect(payload).toMatchObject({
      output: "three",
      output_complete: false,
      output_finalized: false,
      total_lines_scope: "retained",
    });
    expect(payload.output_file).toBeUndefined();
    expect(payload.output_warning).toContain("still running");
  });

  it("reports incomplete retained output without claiming a full-output file", async () => {
    vi.mocked(terminalProvider.getBackgroundState).mockReturnValue({
      is_running: false,
      state: "completed",
      exit_code: 0,
      output: "tail-2\ntail-3",
      output_captured: true,
    });
    terminalProvider.getRetainedOutput = vi.fn(() => ({
      output: "tail-2\ntail-3",
      complete: false,
      finalized: true,
      total_bytes: 12 * 1024 * 1024,
      retained_bytes: 1024 * 1024,
      dropped_bytes: 11 * 1024 * 1024,
    }));

    const result = await handleGetTerminalOutput(
      { terminal_id: "term_42", output_tail: 1 },
      { terminalProvider },
    );
    const payload = textPayload(result);

    expect(payload).toMatchObject({
      output: "tail-3",
      output_complete: false,
      output_dropped_bytes: 11 * 1024 * 1024,
    });
    expect(payload.output_file).toBeUndefined();
    expect(payload.output_warning).toContain(
      "no full-output file is available",
    );
  });

  it("interrupts the terminal when kill is requested", async () => {
    vi.mocked(terminalProvider.getBackgroundState).mockReturnValue({
      is_running: false,
      state: "completed",
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
