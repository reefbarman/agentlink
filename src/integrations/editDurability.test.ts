import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commitAndVerifyEdit } from "./editDurability.js";

interface MutableDocument {
  uri: vscode.Uri;
  isDirty: boolean;
  content: string;
  getText(): string;
  positionAt(offset: number): vscode.Position;
  save(): Promise<boolean>;
}

const tempDirs: string[] = [];

async function makeFile(
  name: string,
  content: string,
): Promise<{ absolutePath: string; relativePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlink-durability-"));
  tempDirs.push(dir);
  const absolutePath = path.join(dir, name);
  await fs.writeFile(absolutePath, content, "utf-8");
  return { absolutePath, relativePath: name };
}

function makeDocument(
  absolutePath: string,
  content: string,
  options?: {
    dirty?: boolean;
    save?: (document: MutableDocument) => Promise<boolean>;
  },
): MutableDocument {
  const document: MutableDocument = {
    uri: vscode.Uri.file(absolutePath),
    isDirty: options?.dirty ?? true,
    content,
    getText() {
      return this.content;
    },
    positionAt(offset) {
      return new vscode.Position(0, offset);
    },
    async save() {
      if (options?.save) return options.save(this);
      await fs.writeFile(absolutePath, this.content, "utf-8");
      this.isDirty = false;
      return true;
    },
  };
  return document;
}

function request(
  document: MutableDocument,
  absolutePath: string,
  relativePath: string,
  baselineContent: string,
) {
  return {
    document: document as unknown as vscode.TextDocument,
    absolutePath,
    relativePath,
    baselineExists: true,
    baselineContent,
    approvedContent: document.content,
    reviewState: "dirty_document_preserved" as const,
  };
}

describe("commitAndVerifyEdit", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(vscode.window, "activeTextEditor", {
      configurable: true,
      value: undefined,
      writable: true,
    });
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementation(async (edit) => {
      const entries = edit.entries();
      const uri = entries[0]?.[0];
      const replacement = entries[0]?.[1][0]?.newText;
      const document = (
        vscode.workspace.textDocuments as unknown as MutableDocument[]
      ).find((candidate) => candidate.uri.fsPath === uri?.fsPath);
      if (!document || replacement === undefined) return false;
      document.content = replacement;
      document.isDirty = true;
      return true;
    });
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) =>
        fs.rm(dir, {
          recursive: true,
          force: true,
        }),
      ),
    );
  });

  it("rejects a stale document whose backing path differs from the target", async () => {
    const target = await makeFile("target.ts", "target baseline");
    const stale = await makeFile("stale.ts", "stale baseline");
    const document = makeDocument(stale.absolutePath, "approved", {
      save: async (doc) => {
        await fs.writeFile(stale.absolutePath, doc.content, "utf-8");
        doc.isDirty = false;
        return true;
      },
    });
    const save = vi.spyOn(document, "save");

    const result = await commitAndVerifyEdit(
      request(
        document,
        target.absolutePath,
        target.relativePath,
        "target baseline",
      ),
    );

    expect(save).not.toHaveBeenCalled();
    expect(await fs.readFile(target.absolutePath, "utf-8")).toBe(
      "target baseline",
    );
    expect(result).toMatchObject({
      status: "error",
      reason: "document_target_mismatch",
      durability: {
        status: "failed",
        outcome: "unverifiable",
        disk_changed: false,
      },
    });
  });

  it("rejects a non-file review document even when its fsPath matches", async () => {
    const target = await makeFile("target.ts", "target baseline");
    const document = makeDocument(target.absolutePath, "approved");
    document.uri = {
      ...document.uri,
      scheme: "agentlink-diff",
    } as vscode.Uri;

    const result = await commitAndVerifyEdit(
      request(
        document,
        target.absolutePath,
        target.relativePath,
        "target baseline",
      ),
    );

    expect(result).toMatchObject({
      status: "error",
      reason: "document_target_mismatch",
      durability: { status: "failed", outcome: "unverifiable" },
    });
  });

  it("uses the normal document save and verifies exact disk content", async () => {
    const target = await makeFile("example.ts", "old");
    const document = makeDocument(target.absolutePath, "new");
    const save = vi.spyOn(document, "save");

    const result = await commitAndVerifyEdit(
      request(document, target.absolutePath, target.relativePath, "old"),
    );

    expect(save).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "accepted",
      finalContent: "new",
      durability: {
        status: "durable",
        outcome: "exact",
        disk_changed: true,
      },
    });
  });

  it("recovers when format-on-save corrupts valid YAML", async () => {
    const target = await makeFile("workflow.yml", "name: old\n");
    const approved = "name: CI\non:\n  push:\n";
    const corrupted = "name: CI\non:\n  push: [\n";
    const document = makeDocument(target.absolutePath, approved, {
      save: async (doc) => {
        doc.content = corrupted;
        await fs.writeFile(target.absolutePath, corrupted, "utf-8");
        doc.isDirty = false;
        return true;
      },
    });
    (vscode.workspace.textDocuments as unknown as MutableDocument[]).push(
      document,
    );
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementationOnce(async () => {
      document.content = approved;
      document.isDirty = true;
      return true;
    });
    const editor = {
      document: document as unknown as vscode.TextDocument,
      viewColumn: vscode.ViewColumn.One,
    } as vscode.TextEditor;
    vi.spyOn(vscode.window, "showTextDocument").mockImplementation(async () => {
      Object.assign(vscode.window, { activeTextEditor: editor });
      return editor;
    });
    vi.spyOn(vscode.commands, "executeCommand").mockImplementation(
      async (name) => {
        expect(name).toBe("workbench.action.files.saveWithoutFormatting");
        await fs.writeFile(target.absolutePath, document.content, "utf-8");
        document.isDirty = false;
        return undefined;
      },
    );

    const result = await commitAndVerifyEdit(
      request(
        document,
        target.absolutePath,
        target.relativePath,
        "name: old\n",
      ),
    );

    expect(result).toMatchObject({
      status: "accepted",
      finalContent: approved,
      durability: { status: "durable", outcome: "exact" },
    });
    expect(await fs.readFile(target.absolutePath, "utf-8")).toBe(approved);
  });

  it("fails closed when corrupted structured content cannot be restored", async () => {
    const target = await makeFile("workflow.yml", "name: old\n");
    const approved = "name: CI\non:\n  push:\n";
    const corrupted = "name: CI\non:\n  push: [\n";
    const document = makeDocument(target.absolutePath, approved, {
      save: async (doc) => {
        doc.content = corrupted;
        await fs.writeFile(target.absolutePath, corrupted, "utf-8");
        doc.isDirty = false;
        return true;
      },
    });
    (vscode.workspace.textDocuments as unknown as MutableDocument[]).push(
      document,
    );
    vi.spyOn(vscode.workspace, "applyEdit").mockResolvedValueOnce(false);

    const result = await commitAndVerifyEdit(
      request(
        document,
        target.absolutePath,
        target.relativePath,
        "name: old\n",
      ),
    );

    expect(result).toMatchObject({
      status: "error",
      reason: "transformed_content_invalid",
      finalContent: corrupted,
      durability: { status: "failed", outcome: "transformed" },
    });
  });

  it("accepts and reports an ordinary save transformation", async () => {
    const target = await makeFile("example.ts", "old");
    const document = makeDocument(target.absolutePath, "const value={a:1}", {
      save: async (doc) => {
        doc.content = "const value = { a: 1 };\n";
        await fs.writeFile(target.absolutePath, doc.content, "utf-8");
        doc.isDirty = false;
        return true;
      },
    });

    const result = await commitAndVerifyEdit(
      request(document, target.absolutePath, target.relativePath, "old"),
    );

    expect(result).toMatchObject({
      status: "accepted",
      format_on_save: true,
      durability: { status: "durable", outcome: "transformed" },
    });
    expect(result.format_on_save_edits).toContain("const value = { a: 1 }");
  });

  it("fails when a save restores the baseline", async () => {
    const target = await makeFile("example.ts", "old");
    const document = makeDocument(target.absolutePath, "new", {
      save: async (doc) => {
        doc.content = "old";
        await fs.writeFile(target.absolutePath, "old", "utf-8");
        doc.isDirty = false;
        return true;
      },
    });

    const result = await commitAndVerifyEdit(
      request(document, target.absolutePath, target.relativePath, "old"),
    );

    expect(result).toMatchObject({
      status: "error",
      reason: "save_reverted_edit",
      durability: { status: "failed", outcome: "reverted" },
    });
  });

  it("fails when editor and disk diverge after save", async () => {
    const target = await makeFile("example.ts", "old");
    const document = makeDocument(target.absolutePath, "new", {
      save: async (doc) => {
        await fs.writeFile(target.absolutePath, "different", "utf-8");
        doc.isDirty = false;
        return true;
      },
    });

    const result = await commitAndVerifyEdit(
      request(document, target.absolutePath, target.relativePath, "old"),
    );

    expect(result).toMatchObject({
      status: "error",
      reason: "editor_disk_diverged",
      durability: { status: "failed", outcome: "diverged" },
    });
  });

  it("reports a missing post-save file as unverifiable", async () => {
    const target = await makeFile("example.ts", "old");
    const document = makeDocument(target.absolutePath, "new", {
      save: async (doc) => {
        await fs.unlink(target.absolutePath);
        doc.isDirty = false;
        return true;
      },
    });

    const result = await commitAndVerifyEdit(
      request(document, target.absolutePath, target.relativePath, "old"),
    );

    expect(result).toMatchObject({
      status: "error",
      reason: "post_save_file_missing",
      durability: {
        status: "failed",
        outcome: "unverifiable",
        final_exists: false,
        error_code: "ENOENT",
      },
    });
  });

  it("uses requested save-without-formatting for ordinary files", async () => {
    const target = await makeFile("example.ts", "old");
    const document = makeDocument(target.absolutePath, "new");
    const editor = {
      document: document as unknown as vscode.TextDocument,
      viewColumn: vscode.ViewColumn.One,
    } as vscode.TextEditor;
    vi.spyOn(vscode.window, "showTextDocument").mockImplementation(async () => {
      Object.assign(vscode.window, { activeTextEditor: editor });
      return editor;
    });
    const command = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockImplementation(async () => {
        await fs.writeFile(target.absolutePath, document.content, "utf-8");
        document.isDirty = false;
        return undefined;
      });

    const result = await commitAndVerifyEdit({
      ...request(document, target.absolutePath, target.relativePath, "old"),
      saveWithoutFormatting: true,
    });

    expect(command).toHaveBeenCalledWith(
      "workbench.action.files.saveWithoutFormatting",
    );
    expect(result).toMatchObject({
      status: "accepted",
      durability: { status: "durable", policy: "preserve_exact" },
    });
  });

  it("uses the active-editor save-without-formatting command for Unity files", async () => {
    const target = await makeFile("Example.meta", "old");
    const document = makeDocument(target.absolutePath, "new");
    const editor = {
      document: document as unknown as vscode.TextDocument,
      viewColumn: vscode.ViewColumn.One,
    } as vscode.TextEditor;
    vi.spyOn(vscode.window, "showTextDocument").mockImplementation(
      async (shownDocument) => {
        expect(shownDocument).toBe(document);
        Object.assign(vscode.window, { activeTextEditor: editor });
        return editor;
      },
    );
    const command = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockImplementation(async (name) => {
        expect(name).toBe("workbench.action.files.saveWithoutFormatting");
        await fs.writeFile(target.absolutePath, document.content, "utf-8");
        document.isDirty = false;
        return undefined;
      });
    const normalSave = vi.spyOn(document, "save");

    const result = await commitAndVerifyEdit(
      request(document, target.absolutePath, target.relativePath, "old"),
    );

    expect(command).toHaveBeenCalledOnce();
    expect(normalSave).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "accepted",
      durability: {
        status: "durable",
        outcome: "exact",
        policy: "preserve_exact",
      },
    });
  });

  it("does not fall back to a normal save when preserving save fails", async () => {
    const target = await makeFile("Example.prefab", "old");
    const document = makeDocument(target.absolutePath, "new");
    const editor = {
      document: document as unknown as vscode.TextDocument,
      viewColumn: vscode.ViewColumn.One,
    } as vscode.TextEditor;
    vi.spyOn(vscode.window, "showTextDocument").mockImplementation(async () => {
      Object.assign(vscode.window, { activeTextEditor: editor });
      return editor;
    });
    vi.spyOn(vscode.commands, "executeCommand").mockRejectedValue(
      new Error("command failed"),
    );
    const normalSave = vi.spyOn(document, "save");

    const result = await commitAndVerifyEdit(
      request(document, target.absolutePath, target.relativePath, "old"),
    );

    expect(normalSave).not.toHaveBeenCalled();
    expect(document.isDirty).toBe(true);
    expect(result).toMatchObject({
      status: "error",
      reason: "preserving_save_failed",
      durability: { status: "failed", outcome: "diverged" },
    });
  });

  it("directly persists a clean stale document that already has approved text", async () => {
    const target = await makeFile("example.ts", "disk baseline");
    const document = makeDocument(target.absolutePath, "approved", {
      dirty: false,
    });
    const save = vi.spyOn(document, "save");

    const result = await commitAndVerifyEdit(
      request(
        document,
        target.absolutePath,
        target.relativePath,
        "disk baseline",
      ),
    );

    expect(save).not.toHaveBeenCalled();
    expect(await fs.readFile(target.absolutePath, "utf-8")).toBe("approved");
    expect(result).toMatchObject({
      status: "accepted",
      durability: { status: "durable", outcome: "exact" },
    });
  });
});
