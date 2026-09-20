import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
