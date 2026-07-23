import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyWorkspaceEditAndSave } from "./workspaceEditOrchestration.js";

const applyEdit = vi.hoisted(() => vi.fn());
const textDocuments = vi.hoisted(
  () =>
    [] as Array<{
      uri: { fsPath: string };
      isDirty: boolean;
      save: ReturnType<typeof vi.fn>;
    }>,
);

vi.mock("vscode", () => ({
  workspace: { applyEdit, textDocuments },
}));

describe("applyWorkspaceEditAndSave", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    textDocuments.length = 0;
  });

  it("returns the owning flow's failure result without saving or building success", async () => {
    applyEdit.mockResolvedValue(false);
    const dirtyDocument = {
      uri: { fsPath: "/workspace/affected.ts" },
      isDirty: true,
      save: vi.fn(),
    };
    textDocuments.push(dirtyDocument);
    const buildSuccess = vi.fn(() => ({ status: "accepted" }));
    const applyFailure = { error: "apply failed" };
    const edit = {} as never;

    const result = await applyWorkspaceEditAndSave({
      edit,
      affectedPaths: [dirtyDocument.uri.fsPath],
      applyFailure,
      buildSuccess,
    });

    expect(result).toBe(applyFailure);
    expect(applyEdit).toHaveBeenCalledWith(edit);
    expect(dirtyDocument.save).not.toHaveBeenCalled();
    expect(buildSuccess).not.toHaveBeenCalled();
  });

  it("returns the owning save failure when an affected document cannot be saved", async () => {
    applyEdit.mockResolvedValue(true);
    const dirtyDocument = {
      uri: { fsPath: "/workspace/dirty.ts" },
      isDirty: true,
      save: vi.fn(async () => false),
    };
    textDocuments.push(dirtyDocument);
    const buildSuccess = vi.fn(() => ({ status: "accepted" }));
    const saveFailure = { error: "save failed" };

    const result = await applyWorkspaceEditAndSave({
      edit: {} as never,
      affectedPaths: [dirtyDocument.uri.fsPath],
      applyFailure: { error: "apply failed" },
      saveFailure,
      buildSuccess,
    });

    expect(result).toBe(saveFailure);
    expect(dirtyDocument.save).toHaveBeenCalledOnce();
    expect(buildSuccess).not.toHaveBeenCalled();
  });

  it("saves only dirty affected documents before building the success result", async () => {
    applyEdit.mockResolvedValue(true);
    const dirtyAffected = {
      uri: { fsPath: "/workspace/dirty.ts" },
      isDirty: true,
      save: vi.fn(async () => true),
    };
    const cleanAffected = {
      uri: { fsPath: "/workspace/clean.ts" },
      isDirty: false,
      save: vi.fn(async () => true),
    };
    const dirtyUnaffected = {
      uri: { fsPath: "/workspace/unaffected.ts" },
      isDirty: true,
      save: vi.fn(async () => true),
    };
    textDocuments.push(dirtyAffected, cleanAffected, dirtyUnaffected);
    const buildSuccess = vi.fn(() => ({ status: "accepted" }));

    const result = await applyWorkspaceEditAndSave({
      edit: {} as never,
      affectedPaths: [
        dirtyAffected.uri.fsPath,
        dirtyAffected.uri.fsPath,
        cleanAffected.uri.fsPath,
        "/workspace/not-open.ts",
      ],
      applyFailure: { error: "apply failed" },
      buildSuccess,
    });

    expect(dirtyAffected.save).toHaveBeenCalledTimes(1);
    expect(cleanAffected.save).not.toHaveBeenCalled();
    expect(dirtyUnaffected.save).not.toHaveBeenCalled();
    expect(buildSuccess).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "accepted" });
  });
});
