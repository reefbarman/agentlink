import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalProvider } from "../core/capabilities/terminal.js";
import { handleCloseTerminals } from "./closeTerminals.js";

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

describe("handleCloseTerminals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an explicit unavailable result when no terminal provider is supplied", async () => {
    const result = await handleCloseTerminals({});

    expect(textPayload(result)).toEqual({
      error:
        "Terminal management is unavailable in this runtime. Provide a TerminalProvider to enable close_terminals.",
    });
  });

  it("returns the legacy empty message when there are no managed terminals", async () => {
    vi.mocked(terminalProvider.listTerminals).mockReturnValue([]);

    await expect(
      handleCloseTerminals({}, { terminalProvider }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "No managed terminals to close." }],
    });
    expect(terminalProvider.closeTerminals).not.toHaveBeenCalled();
  });

  it("closes requested terminals and returns remaining metadata", async () => {
    vi.mocked(terminalProvider.listTerminals)
      .mockReturnValueOnce([
        { id: "term_1", name: "Server", busy: true },
        { id: "term_2", name: "Tests", busy: false },
      ])
      .mockReturnValueOnce([{ id: "term_2", name: "Tests", busy: false }]);
    vi.mocked(terminalProvider.closeTerminals).mockReturnValue({
      closed: 1,
      not_found: ["Missing"],
    });

    const result = await handleCloseTerminals(
      { names: ["Server", "Missing"] },
      { terminalProvider },
    );

    expect(terminalProvider.closeTerminals).toHaveBeenCalledWith([
      "Server",
      "Missing",
    ]);
    expect(textPayload(result)).toEqual({
      closed: 1,
      not_found: ["Missing"],
      remaining: [{ id: "term_2", name: "Tests", busy: false }],
    });
  });

  it("passes undefined names to close all managed terminals", async () => {
    vi.mocked(terminalProvider.listTerminals)
      .mockReturnValueOnce([{ id: "term_1", name: "Server", busy: true }])
      .mockReturnValueOnce([]);
    vi.mocked(terminalProvider.closeTerminals).mockReturnValue({ closed: 1 });

    const result = await handleCloseTerminals({}, { terminalProvider });

    expect(terminalProvider.closeTerminals).toHaveBeenCalledWith(undefined);
    expect(textPayload(result)).toEqual({ closed: 1, remaining: [] });
  });
});
