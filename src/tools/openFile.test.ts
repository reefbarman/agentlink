import { describe, expect, it, vi } from "vitest";

import type { OpenFileProviders } from "./openFile.js";
import { handleOpenFile } from "./openFile.js";

function makeProviders(
  overrides: Partial<OpenFileProviders> = {},
): OpenFileProviders {
  return {
    workspaceFileProvider: {
      resolvePath: vi.fn(() => ({
        absolutePath: "/workspace/src/file.ts",
        inWorkspace: true,
      })),
    },
    pathAccessProvider: {
      ensureAccess: vi.fn(async () => ({ approved: true })),
    },
    editorRevealProvider: {
      reveal: vi.fn(async () => ({
        content: [
          { type: "text" as const, text: JSON.stringify({ status: "opened" }) },
        ],
      })),
    },
    ...overrides,
  };
}

describe("handleOpenFile", () => {
  it("resolves path, checks access, and delegates to the editor reveal provider", async () => {
    const providers = makeProviders();

    const result = await handleOpenFile(
      {
        path: "src/file.ts",
        line: 3,
        column: 4,
        end_line: 5,
        end_column: 6,
      },
      "session-1",
      providers,
    );

    expect(providers.workspaceFileProvider.resolvePath).toHaveBeenCalledWith(
      "src/file.ts",
    );
    expect(providers.pathAccessProvider.ensureAccess).toHaveBeenCalledWith({
      absolutePath: "/workspace/src/file.ts",
      inputPath: "src/file.ts",
      inWorkspace: true,
      sessionId: "session-1",
      kind: "read",
    });
    expect(providers.editorRevealProvider?.reveal).toHaveBeenCalledWith({
      absolutePath: "/workspace/src/file.ts",
      line: 3,
      column: 4,
      end_line: 5,
      end_column: 6,
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: JSON.stringify({ status: "opened" }),
    });
  });

  it("returns the legacy rejected shape when path access is denied", async () => {
    const reveal = vi.fn();
    const providers = makeProviders({
      pathAccessProvider: {
        ensureAccess: vi.fn(async () => ({
          approved: false,
          reason: "outside workspace",
        })),
      },
      editorRevealProvider: { reveal },
    });

    const result = await handleOpenFile(
      { path: "/outside/file.ts" },
      "session-1",
      providers,
    );

    expect(reveal).not.toHaveBeenCalled();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(text)).toEqual({
      status: "rejected",
      path: "/outside/file.ts",
      reason: "outside workspace",
    });
  });

  it("returns explicit unavailable behavior when no editor reveal provider exists", async () => {
    const providers = makeProviders({ editorRevealProvider: undefined });

    const result = await handleOpenFile(
      { path: "src/file.ts" },
      "session-1",
      providers,
    );

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      error: expect.stringContaining("Editor reveal is unavailable"),
      path: "/workspace/src/file.ts",
    });
  });

  it("returns the legacy error shape when resolution throws", async () => {
    const providers = makeProviders({
      workspaceFileProvider: {
        resolvePath: vi.fn(() => {
          throw new Error("No workspace folder open and path is relative");
        }),
      },
    });

    const result = await handleOpenFile(
      { path: "src/file.ts" },
      "session-1",
      providers,
    );

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(text)).toEqual({
      error: "No workspace folder open and path is relative",
      path: "src/file.ts",
    });
  });
});
