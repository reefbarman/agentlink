import { describe, expect, it, vi } from "vitest";

import { handleRenameSymbol } from "./renameSymbol.js";

function textPayload(result: Awaited<ReturnType<typeof handleRenameSymbol>>) {
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

describe("handleRenameSymbol", () => {
  it("returns an explicit unavailable result when no rename provider is supplied", async () => {
    const result = await handleRenameSymbol(
      { path: "src/file.ts", line: 2, column: 3, new_name: "nextName" },
      {} as never,
      "session-1",
    );

    expect(textPayload(result)).toEqual({
      error: "Rename symbol is unavailable in this runtime",
      path: "src/file.ts",
      line: 2,
      column: 3,
    });
  });

  it("delegates portable rename params to the provider", async () => {
    const rename = vi.fn(async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
    }));
    const approvalPanel = {} as never;
    const onApprovalRequest = vi.fn();

    const result = await handleRenameSymbol(
      { path: "src/file.ts", line: 2, column: 3, new_name: "nextName" },
      approvalPanel,
      "session-1",
      onApprovalRequest,
      { renameSymbolProvider: { rename } },
    );

    expect(textPayload(result)).toEqual({ ok: true });
    expect(rename).toHaveBeenCalledWith({
      path: "src/file.ts",
      line: 2,
      column: 3,
      newName: "nextName",
      sessionId: "session-1",
      approvalPanel,
      onApprovalRequest,
    });
  });
});
