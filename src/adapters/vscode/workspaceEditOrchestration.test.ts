import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyWorkspaceEditAndSave,
  applyWorkspaceEditAndSaveWithoutFormatting,
} from "./workspaceEditOrchestration.js";

const applyEdit = vi.hoisted(() => vi.fn());
const openTextDocument = vi.hoisted(() => vi.fn());
const showTextDocument = vi.hoisted(() => vi.fn());
const executeCommand = vi.hoisted(() => vi.fn());
const activeEditor = vi.hoisted(() => ({
  current: undefined as { document: unknown } | undefined,
}));
const textDocuments = vi.hoisted(
  () =>
    [] as Array<{
      uri: { fsPath: string };
      isDirty: boolean;
      save: ReturnType<typeof vi.fn>;
    }>,
);

vi.mock("vscode", () => ({
  workspace: { applyEdit, textDocuments, openTextDocument },
  window: {
    showTextDocument,
    get activeTextEditor() {
      return activeEditor.current;
    },
  },
  commands: { executeCommand },
  Uri: { file: (fsPath: string) => ({ scheme: "file", fsPath }) },
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

describe("applyWorkspaceEditAndSaveWithoutFormatting", () => {
  interface FakeDocument {
    uri: { scheme: "file"; fsPath: string };
    isClosed: boolean;
    isDirty: boolean;
    text: string;
    save: ReturnType<typeof vi.fn>;
    getText(): string;
  }

  let tempDir: string;
  let documents: Map<string, FakeDocument>;
  /** Content each save-without-formatting writes, keyed by path. */
  let saveTransforms: Map<string, (text: string) => string>;
  let failingSaves: Set<string>;

  function createFile(name: string, content: string): string {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, content, "utf-8");
    const document: FakeDocument = {
      uri: { scheme: "file", fsPath: filePath },
      isClosed: false,
      isDirty: false,
      text: content,
      save: vi.fn(async () => true),
      getText() {
        return this.text;
      },
    };
    documents.set(filePath, document);
    return filePath;
  }

  function applyReplacements(replacements: Record<string, string>) {
    applyEdit.mockImplementation(async () => {
      for (const [filePath, text] of Object.entries(replacements)) {
        const document = documents.get(filePath)!;
        document.text = text;
        document.isDirty = true;
      }
      return true;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    textDocuments.length = 0;
    activeEditor.current = undefined;
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-exact-edit-")),
    );
    documents = new Map();
    saveTransforms = new Map();
    failingSaves = new Set();
    openTextDocument.mockImplementation(async (uri: { fsPath: string }) =>
      documents.get(uri.fsPath),
    );
    showTextDocument.mockImplementation(async (document: FakeDocument) => {
      activeEditor.current = { document };
      return { document };
    });
    executeCommand.mockImplementation(async (command: string) => {
      if (command !== "workbench.action.files.saveWithoutFormatting") return;
      const document = activeEditor.current?.document as
        | FakeDocument
        | undefined;
      if (!document || failingSaves.has(document.uri.fsPath)) return;
      const transform = saveTransforms.get(document.uri.fsPath);
      if (transform) document.text = transform(document.text);
      fs.writeFileSync(document.uri.fsPath, document.text, "utf-8");
      document.isDirty = false;
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("saves every target through save-without-formatting and reports exact durability", async () => {
    const first = createFile("first.ts", "const a = old;\n");
    const second = createFile("second.ts", "old  ;\n");
    applyReplacements({
      [first]: "const a = new;\n",
      [second]: "new  ;\n",
    });
    const buildResult = vi.fn((commits: readonly unknown[]) => ({ commits }));

    const result = await applyWorkspaceEditAndSaveWithoutFormatting({
      edit: {} as never,
      targets: [
        { absolutePath: first, relativePath: "first.ts" },
        { absolutePath: second, relativePath: "second.ts" },
      ],
      applyFailure: { error: "apply failed" },
      buildResult,
    });

    expect(buildResult).toHaveBeenCalledOnce();
    expect(result).toEqual({
      commits: [
        expect.objectContaining({
          status: "accepted",
          path: "first.ts",
          durability: expect.objectContaining({
            status: "durable",
            outcome: "exact",
            policy: "preserve_exact",
            final_content_hash: expect.any(String),
          }),
        }),
        expect.objectContaining({
          status: "accepted",
          path: "second.ts",
          durability: expect.objectContaining({
            status: "durable",
            outcome: "exact",
            policy: "preserve_exact",
          }),
        }),
      ],
    });
    expect(executeCommand).toHaveBeenCalledTimes(2);
    for (const document of documents.values()) {
      expect(document.save).not.toHaveBeenCalled();
    }
    expect(fs.readFileSync(first, "utf-8")).toBe("const a = new;\n");
    expect(fs.readFileSync(second, "utf-8")).toBe("new  ;\n");
  });

  it("returns the apply failure without saving when the edit is rejected", async () => {
    const filePath = createFile("rejected.ts", "old");
    applyEdit.mockResolvedValue(false);
    const buildResult = vi.fn();
    const applyFailure = { error: "apply failed" };

    const result = await applyWorkspaceEditAndSaveWithoutFormatting({
      edit: {} as never,
      targets: [{ absolutePath: filePath, relativePath: "rejected.ts" }],
      applyFailure,
      buildResult,
    });

    expect(result).toBe(applyFailure);
    expect(buildResult).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("attempts every target and reports failed saves and transformed content per file", async () => {
    const failed = createFile("failed.ts", "old");
    const transformed = createFile("transformed.ts", "old");
    const saved = createFile("saved.ts", "old");
    const thrown = createFile("thrown.ts", "old");
    applyReplacements({
      [failed]: "new",
      [transformed]: "new",
      [saved]: "new",
      [thrown]: "new",
    });
    failingSaves.add(failed);
    saveTransforms.set(transformed, (text) => `${text}\n`);
    const realOpen = openTextDocument.getMockImplementation()!;
    openTextDocument.mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === thrown) throw new Error("token=secret-value");
      return realOpen(uri);
    });

    const result = (await applyWorkspaceEditAndSaveWithoutFormatting({
      edit: {} as never,
      targets: [
        { absolutePath: failed, relativePath: "failed.ts" },
        { absolutePath: transformed, relativePath: "transformed.ts" },
        { absolutePath: saved, relativePath: "saved.ts" },
        { absolutePath: thrown, relativePath: "thrown.ts" },
      ],
      applyFailure: { error: "apply failed" },
      buildResult: (commits) => commits,
    })) as unknown as ReadonlyArray<Record<string, unknown>>;

    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({
      status: "error",
      path: "failed.ts",
      reason: "preserving_save_failed",
      error: "File could not be saved without formatting",
    });
    expect(result[1]).toMatchObject({
      status: "error",
      path: "transformed.ts",
      reason: "exact_preservation_failed",
      durability: { status: "failed", outcome: "transformed" },
    });
    expect(result[2]).toMatchObject({
      status: "accepted",
      path: "saved.ts",
      durability: { status: "durable", outcome: "exact" },
    });
    expect(result[3]).toMatchObject({
      status: "error",
      path: "thrown.ts",
      reason: "preserving_save_failed",
    });
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(fs.readFileSync(saved, "utf-8")).toBe("new");
  });
});
