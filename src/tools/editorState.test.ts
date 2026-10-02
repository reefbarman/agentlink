import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextDocument } from "vscode";
import { commitAndVerifyEdit } from "../integrations/editDurability.js";
import { MAX_EDITOR_RECOVERY_BYTES } from "../integrations/editorRecoveryPolicy.js";
import {
  handleGetEditorState,
  handleSaveEditor,
  type EditorStateContext,
} from "./editorState.js";

const state = vi.hoisted(() => ({
  documents: [] as unknown[],
  active: undefined as unknown,
  show: vi.fn(),
  command: vi.fn(),
}));
vi.mock("vscode", () => ({
  workspace: {
    get textDocuments() {
      return state.documents;
    },
  },
  window: {
    get activeTextEditor() {
      return state.active;
    },
    showTextDocument: state.show,
  },
  commands: { executeCommand: state.command },
}));
vi.mock("../util/paths.js", async () => {
  const fs = await import("node:fs");
  return {
    canonicalizePath: (value: string) => {
      try {
        return fs.realpathSync(value);
      } catch {
        return value;
      }
    },
    resolveAndValidatePath: (value: string) => ({
      absolutePath: value,
      inWorkspace: true,
    }),
    getRelativePath: (value: string) => value,
  };
});

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function payload(result: Awaited<ReturnType<typeof handleGetEditorState>>) {
  const content = result.content[0];
  return JSON.parse(content.type === "text" ? content.text : "{}");
}

describe("editor recovery", () => {
  let dir: string;
  let file: string;
  let doc: {
    uri: { scheme: string; fsPath: string };
    version: number;
    isDirty: boolean;
    isClosed: boolean;
    text: string;
    getText(): string;
  };
  let context: EditorStateContext;
  beforeEach(async () => {
    dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "editor-state-")),
    );
    file = path.join(dir, "example.ts");
    await fs.writeFile(file, "old\n");
    doc = {
      uri: { scheme: "file", fsPath: file },
      version: 4,
      isDirty: true,
      isClosed: false,
      text: "new\n",
      getText() {
        return this.text;
      },
    };
    state.documents = [doc];
    state.active = undefined;
    state.show.mockReset().mockImplementation(async (document) => {
      state.active = { document };
      return state.active;
    });
    state.command.mockReset().mockImplementation(async () => {
      await fs.writeFile(file, doc.text);
      doc.isDirty = false;
    });
    context = {
      sessionId: "session",
      pathAccessProvider: {
        ensureAccess: vi.fn(async () => ({ approved: true })),
      },
      onApprovalRequest: vi.fn(async () => "accept"),
    };
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const params = () => ({
    path: file,
    disk_hash: digest("old\n"),
    editor_hash: digest(doc.text),
    editor_version: doc.version,
  });

  it("does not dispatch an exact save to a different document with the same fsPath", async () => {
    state.show.mockImplementation(async () => {
      state.active = {
        document: { ...doc, uri: { ...doc.uri, scheme: "untitled" } },
      };
      return state.active;
    });
    const result = await commitAndVerifyEdit({
      document: doc as unknown as TextDocument,
      absolutePath: file,
      relativePath: "example.ts",
      baselineExists: true,
      baselineContent: "old\n",
      approvedContent: doc.text,
      reviewState: "dirty_document_preserved",
      saveWithoutFormatting: true,
    });
    expect(result.reason).toBe("preserving_save_failed");
    expect(state.command).not.toHaveBeenCalled();
    expect(doc.text).toBe("new\n");
    expect(await fs.readFile(file, "utf8")).toBe("old\n");
  });

  it("makes preserving-save failure guidance usable by the actual recovery tool", async () => {
    state.command.mockResolvedValue(undefined);
    const result = await commitAndVerifyEdit({
      document: doc as unknown as TextDocument,
      absolutePath: file,
      relativePath: "example.ts",
      baselineExists: true,
      baselineContent: "old\n",
      approvedContent: doc.text,
      reviewState: "dirty_document_preserved",
      saveWithoutFormatting: true,
    });
    expect(result.reason).toBe("preserving_save_failed");
    expect(result.next_steps?.join(" ")).toContain("Use get_editor_state");
    const inspected = payload(
      await handleGetEditorState({ path: file }, context),
    );
    expect(inspected).toMatchObject({
      source: "editor_buffer",
      editor_hash: digest(doc.text),
      disk_hash: digest("old\n"),
      document_dirty: true,
    });
    expect(await fs.readFile(file, "utf8")).toBe("old\n");
  });

  it.each(["missing", "closed", "non-file", "oversized"])(
    "does not advertise unavailable recovery after a failed save (%s)",
    async (kind) => {
      state.command.mockImplementation(async () => {
        if (kind === "missing") state.documents = [];
        if (kind === "closed") doc.isClosed = true;
        if (kind === "non-file") doc.uri.scheme = "untitled";
        if (kind === "oversized")
          doc.text = "x".repeat(MAX_EDITOR_RECOVERY_BYTES + 1);
      });
      const result = await commitAndVerifyEdit({
        document: doc as unknown as TextDocument,
        absolutePath: file,
        relativePath: "example.ts",
        baselineExists: true,
        baselineContent: "old\n",
        approvedContent: doc.text,
        reviewState: "dirty_document_preserved",
        saveWithoutFormatting: true,
      });
      expect(result.reason).toBe("preserving_save_failed");
      expect(result.next_steps?.join(" ")).not.toMatch(
        /get_editor_state|save_editor/,
      );
      expect(result.next_steps?.join(" ")).toContain(
        "Inspect and reconcile it in VS Code",
      );
      expect(
        payload(await handleGetEditorState({ path: file }, context)),
      ).toHaveProperty("error");
      expect(await fs.readFile(file, "utf8")).toBe("old\n");
    },
  );

  it("recovers a failed ordinary save for a large file through inspected hashes and explicit exact-save approval", async () => {
    const lines = Array.from(
      { length: 9_000 },
      (_, index) => `const item${index} = "${"baseline".repeat(6)}";`,
    );
    const baseline = `${lines.join("\n")}\n`;
    lines[7_710] = 'const item7710 = "approved change";';
    doc.text = `${lines.join("\n")}\n`;
    await fs.writeFile(file, baseline);
    expect(Buffer.byteLength(baseline)).toBeGreaterThan(256 * 1024);
    const document = Object.assign(doc, { save: vi.fn(async () => false) });
    const failed = await commitAndVerifyEdit({
      document: document as unknown as TextDocument,
      absolutePath: file,
      relativePath: "example.ts",
      baselineExists: true,
      baselineContent: baseline,
      approvedContent: doc.text,
      reviewState: "dirty_document_preserved",
    });
    expect(failed).toMatchObject({
      status: "error",
      reason: "save_failed",
      save_failure: {
        save_outcome: "returned_false",
        dirty_document_state: "matches_save_attempt",
        vscode_error_detail: "unavailable",
      },
    });
    expect(failed.next_steps?.join(" ")).toContain("Use get_editor_state");
    expect(failed.next_steps?.join(" ")).toContain("skips formatting");
    const inspected = payload(
      await handleGetEditorState(
        { path: file, offset: 7_700, limit: 40 },
        context,
      ),
    );
    expect(inspected).toMatchObject({
      editor_hash: digest(doc.text),
      disk_hash: digest(baseline),
      editor_version: doc.version,
      document_dirty: true,
    });
    expect(inspected.content.split("\n")).toHaveLength(40);
    expect(inspected.content).toContain("7711 | const item7710");
    expect(inspected.disk_to_editor_diff).toContain("approved change");
    expect(inspected.diff_truncated).toBe(false);
    context.onApprovalRequest = vi.fn(async (request) => {
      expect(request.title).toContain("without formatting");
      expect(request.detail).toContain(
        "skips formatting and ordinary save participants",
      );
      expect(state.command).not.toHaveBeenCalled();
      expect(await fs.readFile(file, "utf8")).toBe(baseline);
      return "accept";
    });
    const saved = payload(
      await handleSaveEditor(
        {
          path: file,
          editor_hash: inspected.editor_hash,
          disk_hash: inspected.disk_hash,
          editor_version: inspected.editor_version,
        },
        context,
      ),
    );
    expect(saved).toMatchObject({
      status: "accepted",
      durability: { outcome: "exact", final_content_hash: digest(doc.text) },
    });
    expect(state.command).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(file, "utf8")).toBe(doc.text);
  });

  it.each(["disk", "buffer"])(
    "retains the snapshot ceiling for oversized %s",
    async (kind) => {
      const oversized = "x".repeat(MAX_EDITOR_RECOVERY_BYTES + 1);
      if (kind === "disk") await fs.writeFile(file, oversized);
      else doc.text = oversized;
      expect(
        payload(await handleGetEditorState({ path: file, limit: 1 }, context))
          .error,
      ).toContain("8 MiB");
      expect(
        payload(await handleSaveEditor(params(), context)).error,
      ).toContain("8 MiB");
      expect(context.onApprovalRequest).not.toHaveBeenCalled();
      expect(state.command).not.toHaveBeenCalled();
      expect(doc.isDirty).toBe(true);
    },
  );

  it.each(["replacement", "eol"])(
    "returns inspection hashes but refuses save approval when a %s diff exceeds its computation budget",
    async (kind) => {
      const baseline = "const before = 1;\r\n".repeat(3_000);
      doc.text =
        kind === "eol"
          ? baseline.replaceAll("\r\n", "\n")
          : "const after = 2;\n".repeat(3_000);
      await fs.writeFile(file, baseline);
      const inspected = payload(
        await handleGetEditorState({ path: file, limit: 1 }, context),
      );
      expect(inspected).toMatchObject({
        editor_hash: digest(doc.text),
        disk_hash: digest(baseline),
        diff_omitted_reason: "computation_limit",
      });
      expect(inspected).not.toHaveProperty("disk_to_editor_diff");
      const result = payload(
        await handleSaveEditor(
          { ...params(), disk_hash: digest(baseline) },
          context,
        ),
      );
      expect(result.reason).toBe("editor_approval_diff_unavailable");
      expect(context.onApprovalRequest).not.toHaveBeenCalled();
      expect(state.command).not.toHaveBeenCalled();
      expect(await fs.readFile(file, "utf8")).toBe(baseline);
    },
  );

  it("does not approve a truncated save diff even when diff computation succeeds", async () => {
    doc.text = "x".repeat(17_000);
    const inspected = payload(
      await handleGetEditorState({ path: file }, context),
    );
    expect(inspected.content.length).toBeLessThanOrEqual(16_000);
    expect(inspected.diff_truncated).toBe(true);
    expect(payload(await handleSaveEditor(params(), context)).reason).toBe(
      "editor_approval_too_large",
    );
    expect(context.onApprovalRequest).not.toHaveBeenCalled();
    expect(state.command).not.toHaveBeenCalled();
  });

  it("returns labelled buffer content and independent hashes without changing it", async () => {
    const result = payload(await handleGetEditorState({ path: file }, context));
    expect(result).toMatchObject({
      source: "editor_buffer",
      editor_version: 4,
      editor_hash: digest("new\n"),
      disk_hash: digest("old\n"),
      document_dirty: true,
    });
    expect(result.content).toContain("1 | new");
    expect(result.disk_to_editor_diff).toContain("-old");
    expect(state.command).not.toHaveBeenCalled();
  });
  it("redacts eligible configuration on both sides before generating differences", async () => {
    file = path.join(dir, "settings.json");
    doc.uri.fsPath = file;
    doc.text = '{"apiKey":"new-secret"}';
    await fs.writeFile(file, '{"apiKey":"old-secret"}');
    const result = payload(await handleGetEditorState({ path: file }, context));
    expect(result.redacted).toBe(true);
    expect(JSON.stringify(result)).not.toContain("new-secret");
    expect(JSON.stringify(result)).not.toContain("old-secret");
  });
  it("keeps secret-bearing configuration out of approval history", async () => {
    file = path.join(dir, "settings.json");
    doc.uri.fsPath = file;
    doc.text = '{"apiKey":"private-value"}';
    await fs.writeFile(file, "{}");
    const result = await handleSaveEditor(
      { ...params(), disk_hash: digest("{}") },
      context,
    );
    expect(payload(result).reason).toBe("editor_private_review_required");
    expect(JSON.stringify(result)).not.toContain("private-value");
    expect(context.onApprovalRequest).not.toHaveBeenCalled();
    expect(state.command).not.toHaveBeenCalled();
  });

  it("allows inspection while save approval is pending", async () => {
    context.onApprovalRequest = vi.fn(async () => {
      expect(
        payload(await handleGetEditorState({ path: file }, context))
          .editor_version,
      ).toBe(4);
      return "accept";
    });
    expect(payload(await handleSaveEditor(params(), context)).status).toBe(
      "accepted",
    );
  });

  it("saves the exact buffer after one-shot approval with no permanent trust choices", async () => {
    const result = payload(await handleSaveEditor(params(), context));
    expect(result.status).toBe("accepted");
    expect(result.durability.final_content_hash).toBe(digest("new\n"));
    expect(context.onApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "write",
        writeChoices: expect.arrayContaining([
          expect.objectContaining({ value: "accept" }),
        ]),
      }),
      "session",
    );
    expect(
      vi.mocked(context.onApprovalRequest!).mock.calls[0][0].fileWrite,
    ).toBeUndefined();
    expect(state.command).toHaveBeenCalledWith(
      "workbench.action.files.saveWithoutFormatting",
    );
    expect(await fs.readFile(file, "utf8")).toBe("new\n");
  });
  it.each(["reject", "accept-session"])(
    "leaves buffer untouched for %s",
    async (decision) => {
      context.onApprovalRequest = vi.fn(async () => decision);
      expect(payload(await handleSaveEditor(params(), context)).status).toBe(
        "rejected_by_user",
      );
      expect(doc.text).toBe("new\n");
      expect(doc.isDirty).toBe(true);
      expect(state.show).not.toHaveBeenCalled();
      expect(state.command).not.toHaveBeenCalled();
      expect(await fs.readFile(file, "utf8")).toBe("old\n");
    },
  );
  it.each(["disk", "buffer", "version"])(
    "rejects stale %s before approval",
    async (kind) => {
      const input = params();
      if (kind === "disk") await fs.writeFile(file, "external");
      if (kind === "buffer") doc.text = "user work";
      if (kind === "version") doc.version++;
      expect(payload(await handleSaveEditor(input, context)).reason).toBe(
        "editor_state_changed",
      );
      expect(context.onApprovalRequest).not.toHaveBeenCalled();
      expect(state.command).not.toHaveBeenCalled();
    },
  );
  it.each(["disk", "buffer", "cancel"])(
    "rejects %s drift during approval",
    async (kind) => {
      const controller = new AbortController();
      context.signal = controller.signal;
      context.onApprovalRequest = vi.fn(async () => {
        if (kind === "disk") await fs.writeFile(file, "external");
        if (kind === "buffer") {
          doc.text = "user work";
          doc.version++;
        }
        if (kind === "cancel") controller.abort();
        return "accept";
      });
      expect(payload(await handleSaveEditor(params(), context)).reason).toBe(
        "editor_state_changed",
      );
      expect(state.command).not.toHaveBeenCalled();
    },
  );
  it("rechecks after asynchronous editor activation", async () => {
    state.show.mockImplementation(async (document) => {
      doc.text = "new user work";
      doc.version++;
      state.active = { document };
      return state.active;
    });
    expect(payload(await handleSaveEditor(params(), context)).reason).toBe(
      "editor_save_failed",
    );
    expect(state.command).not.toHaveBeenCalled();
    expect(doc.text).toBe("new user work");
  });
  it("does not save another active editor", async () => {
    state.show.mockImplementation(async (document) => ({ document }));
    expect(payload(await handleSaveEditor(params(), context)).reason).toBe(
      "editor_save_failed",
    );
    expect(state.command).not.toHaveBeenCalled();
  });
  it("reports failure rather than accepting changed save output", async () => {
    state.command.mockImplementation(async () => {
      await fs.writeFile(file, "transformed");
      doc.isDirty = false;
    });
    expect(payload(await handleSaveEditor(params(), context)).reason).toBe(
      "editor_save_failed",
    );
  });
  it("rejects protected instructions", async () => {
    file = path.join(dir, "CLAUDE.md");
    doc.uri.fsPath = file;
    expect(payload(await handleSaveEditor(params(), context)).reason).toBe(
      "protected_editor_target",
    );
    expect(state.command).not.toHaveBeenCalled();
  });
  it("supports explicit absent disk preconditions", async () => {
    await fs.unlink(file);
    expect(
      payload(await handleSaveEditor({ ...params(), disk_hash: null }, context))
        .status,
    ).toBe("accepted");
  });
  it("requires path read authorization", async () => {
    context.pathAccessProvider.ensureAccess = vi.fn(async () => ({
      approved: false,
    }));
    const result = await handleGetEditorState({ path: file }, context);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("new\\n");
  });
  it("returns an explicit no-op for an already-saved matching buffer", async () => {
    doc.text = "old\n";
    doc.isDirty = false;
    expect(payload(await handleSaveEditor(params(), context)).status).toBe(
      "already_saved",
    );
    expect(context.onApprovalRequest).not.toHaveBeenCalled();
  });
});
