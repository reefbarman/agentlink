import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAndOpenDocument } from "./languageFeatures.js";

const {
  resolveAndValidatePath,
  approveOutsideWorkspaceAccess,
  openTextDocument,
} = vi.hoisted(() => ({
  resolveAndValidatePath: vi.fn(),
  approveOutsideWorkspaceAccess: vi.fn(),
  openTextDocument: vi.fn(),
}));

vi.mock("../util/paths.js", () => ({
  resolveAndValidatePath,
  getRelativePath: vi.fn((filePath: string) => filePath),
}));
vi.mock("./pathAccessUI.js", () => ({ approveOutsideWorkspaceAccess }));
vi.mock("../util/agentlinkTmpArtifacts.js", () => ({
  isAgentlinkTmpArtifact: vi.fn(() => false),
}));
vi.mock("vscode", async () => ({
  ...(await import("../__mocks__/vscode.js")),
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  workspace: { openTextDocument },
}));

describe("resolveAndOpenDocument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openTextDocument.mockResolvedValue({ languageId: "markdown" });
  });

  it.each([
    "/Users/tester/.claude/CLAUDE.md",
    "/Users/tester/.agentlink/skills/helper/SKILL.md",
  ])(
    "opens exact outside-workspace agent instruction artifact %s without approval",
    async (instructionPath) => {
      resolveAndValidatePath.mockReturnValue({
        absolutePath: instructionPath,
        inWorkspace: false,
      });
      const approvalManager = { isPathTrusted: vi.fn(() => false) };

      await expect(
        resolveAndOpenDocument(
          instructionPath,
          approvalManager as never,
          {} as never,
          "session-1",
        ),
      ).resolves.toMatchObject({ absolutePath: instructionPath });

      expect(approvalManager.isPathTrusted).not.toHaveBeenCalled();
      expect(approveOutsideWorkspaceAccess).not.toHaveBeenCalled();
      expect(openTextDocument).toHaveBeenCalledWith({
        fsPath: instructionPath,
      });
    },
  );

  it.each([true, false])(
    "honours the supplied read path policy before opening a document (%s)",
    async (approved) => {
      const filePath = "/outside/skills/helper/references/guide.md";
      resolveAndValidatePath.mockReturnValue({
        absolutePath: filePath,
        inWorkspace: false,
      });
      const pathAccessProvider = {
        ensureAccess: vi
          .fn()
          .mockResolvedValue({ approved, reason: "read policy" }),
      };
      const result = resolveAndOpenDocument(
        filePath,
        {} as never,
        {} as never,
        "session-1",
        undefined,
        pathAccessProvider,
      );
      if (approved) {
        await expect(result).resolves.toMatchObject({ absolutePath: filePath });
        expect(openTextDocument).toHaveBeenCalledOnce();
      } else {
        await expect(result).rejects.toMatchObject({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "rejected",
                path: filePath,
                reason: "read policy",
              }),
            },
          ],
        });
        expect(openTextDocument).not.toHaveBeenCalled();
      }
      expect(pathAccessProvider.ensureAccess).toHaveBeenCalledWith({
        absolutePath: filePath,
        inputPath: filePath,
        inWorkspace: false,
        sessionId: "session-1",
        kind: "read",
      });
      expect(approveOutsideWorkspaceAccess).not.toHaveBeenCalled();
    },
  );

  it("still requests approval for arbitrary outside-workspace files", async () => {
    const filePath = "/Users/tester/.agentlink/memory.md";
    resolveAndValidatePath.mockReturnValue({
      absolutePath: filePath,
      inWorkspace: false,
    });
    approveOutsideWorkspaceAccess.mockResolvedValue({
      approved: false,
      reason: "approval required",
    });

    await expect(
      resolveAndOpenDocument(
        filePath,
        { isPathTrusted: vi.fn(() => false) } as never,
        {} as never,
        "session-1",
      ),
    ).rejects.toMatchObject({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "rejected",
            path: filePath,
            reason: "approval required",
          }),
        },
      ],
    });

    expect(approveOutsideWorkspaceAccess).toHaveBeenCalledOnce();
    expect(openTextDocument).not.toHaveBeenCalled();
  });
});
