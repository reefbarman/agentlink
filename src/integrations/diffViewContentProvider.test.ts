import {
  DIFF_VIEW_URI_SCHEME,
  decodeDiffViewContent,
  registerDiffViewContentProvider,
} from "./diffViewContentProvider.js";
import { describe, expect, it, vi } from "vitest";

const { registerTextDocumentContentProvider } = vi.hoisted(() => ({
  registerTextDocumentContentProvider: vi.fn(),
}));

vi.mock("vscode", () => ({
  workspace: { registerTextDocumentContentProvider },
}));

describe("diff view content provider", () => {
  it("preserves the registered URI scheme", () => {
    expect(DIFF_VIEW_URI_SCHEME).toBe("agentlink-diff");
  });

  it.each([
    ["empty content", ""],
    ["multiline content", "first line\nsecond line\n"],
    ["UTF-8 content", 'const message = "Hello, 世界 👋";\n'],
  ])("decodes %s from base64", (_label, content) => {
    expect(
      decodeDiffViewContent({
        query: Buffer.from(content).toString("base64"),
      }),
    ).toBe(content);
  });

  it("registers the readonly provider and returns its disposable", () => {
    const disposable = { dispose: vi.fn() };
    registerTextDocumentContentProvider.mockReturnValue(disposable);

    expect(registerDiffViewContentProvider()).toBe(disposable);
    expect(registerTextDocumentContentProvider).toHaveBeenCalledOnce();

    const [scheme, provider] =
      registerTextDocumentContentProvider.mock.calls[0];
    expect(scheme).toBe("agentlink-diff");
    expect(
      provider.provideTextDocumentContent({
        query: Buffer.from("diff content").toString("base64"),
      }),
    ).toBe("diff content");
  });
});
