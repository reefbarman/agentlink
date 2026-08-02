import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import {
  DiffViewProvider,
  createFormatOnSaveReport,
  createUserEditsPatch,
  diagnoseEditApplyFailure,
  diagnoseEditSaveFailure,
  interactiveDiffEditorOptions,
  interactiveFallbackEditorOptions,
  isIgnorableTabCloseError,
  revealPendingDiff,
} from "./DiffViewProvider.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withFileLock } from "../util/fileLock.js";

// Each test uses a unique path to avoid interference from the shared
// module-level pathLocks Map.
let pathCounter = 0;
function uniquePath(): string {
  return `/test/lock-${++pathCounter}-${Date.now()}`;
}

describe("isIgnorableTabCloseError", () => {
  it("returns true for invalid-tab race message", () => {
    expect(
      isIgnorableTabCloseError(new Error("Tab close: Invalid tab not found!")),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isIgnorableTabCloseError(
        new Error("Permission denied while closing tab"),
      ),
    ).toBe(false);
  });
});

describe("createFormatOnSaveReport", () => {
  it("returns undefined when saved content matches expected content", () => {
    expect(
      createFormatOnSaveReport(
        "src/example.ts",
        "const x = 1;\n",
        "const x = 1;\n",
      ),
    ).toBeUndefined();
  });

  it("returns a bounded patch when format-on-save changes content", () => {
    const report = createFormatOnSaveReport(
      "src/example.ts",
      "const value={a:1}\n",
      "const value = { a: 1 };\n",
    );

    expect(report).toMatchObject({ format_on_save: true });
    expect(report?.format_on_save_edits).toContain("Index: src/example.ts");
    expect(report?.format_on_save_edits).toContain(
      "--- src/example.ts\tproposed",
    );
    expect(report?.format_on_save_edits).toContain("+++ src/example.ts\tsaved");
    expect(report?.format_on_save_edits).toContain("-const value={a:1}");
    expect(report?.format_on_save_edits).toContain("+const value = { a: 1 };");
  });

  it("omits oversized format patches with a structured fallback", () => {
    const expected = Array.from({ length: 300 }, (_, i) => `x${i}=1`).join(
      "\n",
    );
    const final = Array.from({ length: 300 }, (_, i) => `x${i} = 1;`).join(
      "\n",
    );

    const report = createFormatOnSaveReport("src/large.ts", expected, final);

    expect(report).toMatchObject({
      format_on_save: true,
      format_on_save_edits_omitted: "size_cap",
    });
    expect(report?.format_on_save_edits).toBeUndefined();
    expect(report?.hint).toContain("re-read");
  });

  it("reports EOL-only changes as metadata", () => {
    const report = createFormatOnSaveReport(
      "src/example.ts",
      "a\r\nb\r\n",
      "a\nb\n",
    );

    expect(report).toEqual({
      format_on_save: true,
      eol_changed: true,
    });
  });

  it.each(["Assets/Example.meta", "Assets/Example.prefab"])(
    "warns when format-on-save changes a Unity serialization file (%s)",
    (relPath) => {
      const report = createFormatOnSaveReport(
        relPath,
        "guid: abc",
        "guid: abc\nlabels: []",
      );

      expect(report).toMatchObject({
        format_on_save: true,
        warnings: [expect.stringContaining("Unity serialization")],
      });
    },
  );

  it("does not add a Unity warning for ordinary YAML files", () => {
    const report = createFormatOnSaveReport(
      "config/example.yaml",
      "value:one",
      "value: one",
    );

    expect(report).toMatchObject({ format_on_save: true });
    expect(report?.warnings).toBeUndefined();
  });
});

describe("interactive review editor options", () => {
  it("reveals the diff in the primary editor group", () => {
    expect(interactiveDiffEditorOptions()).toEqual({
      preview: true,
      viewColumn: 1,
    });
  });

  it("reveals the fallback file in the primary editor group", () => {
    expect(interactiveFallbackEditorOptions()).toEqual({
      viewColumn: 1,
    });
  });
});

describe("revealPendingDiff", () => {
  it("reveals only the pending diff matching the request id", async () => {
    Object.assign(vscode.window.tabGroups, {
      onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
    });

    let resolveFirst!: (decision: string) => void;
    let resolveSecond!: (decision: string) => void;
    const firstApproval = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const secondApproval = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveSecond = resolve;
        }),
    );
    const firstReveal = vi.fn().mockResolvedValue(undefined);
    const secondReveal = vi.fn().mockResolvedValue(undefined);
    const first = new DiffViewProvider(0, "diff-request-1");
    const second = new DiffViewProvider(0, "diff-request-2");
    Object.assign(first, {
      absolutePath: "/workspace/first.ts",
      relPath: "first.ts",
      originalContent: "",
      newContent: "first",
      editType: "modify",
      revealDiff: firstReveal,
    });
    Object.assign(second, {
      absolutePath: "/workspace/second.ts",
      relPath: "second.ts",
      originalContent: "",
      newContent: "second",
      editType: "modify",
      revealDiff: secondReveal,
    });

    const firstDecision = first.waitForUserDecision({} as never, firstApproval);
    const secondDecision = second.waitForUserDecision(
      {} as never,
      secondApproval,
    );
    await vi.waitFor(() => {
      expect(firstApproval).toHaveBeenCalledOnce();
      expect(secondApproval).toHaveBeenCalledOnce();
    });

    await expect(revealPendingDiff("missing-request")).resolves.toBe(false);
    await expect(revealPendingDiff("diff-request-2")).resolves.toBe(true);
    expect(firstReveal).not.toHaveBeenCalled();
    expect(secondReveal).toHaveBeenCalledOnce();

    resolveFirst("reject");
    resolveSecond("reject");
    await expect(firstDecision).resolves.toBe("reject");
    await expect(secondDecision).resolves.toBe("reject");
  });
});

describe("createUserEditsPatch", () => {
  it("returns undefined when edited content matches proposed content", () => {
    expect(
      createUserEditsPatch(
        "src/example.ts",
        "const value = 1;\n",
        "const value = 1;\n",
      ),
    ).toBeUndefined();
  });

  it("returns a patch from proposed to user-edited content", () => {
    const patch = createUserEditsPatch(
      "src/example.ts",
      "const value = 1;\n",
      "const value = 2;\n",
    );

    expect(patch).toContain("Index: src/example.ts");
    expect(patch).toContain("--- src/example.ts\tproposed");
    expect(patch).toContain("+++ src/example.ts\tuser-edited");
    expect(patch).toContain("-const value = 1;");
    expect(patch).toContain("+const value = 2;");
  });
});

describe("diagnoseEditSaveFailure", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  async function makeFile(content: string): Promise<string> {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-save-failure-"),
    );
    tempDirs.push(dir);
    const filePath = path.join(dir, "file.ts");
    await fs.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  it("reports an unchanged disk baseline and preserved diff snapshot", async () => {
    const filePath = await makeFile("old");

    await expect(
      diagnoseEditSaveFailure({
        absolutePath: filePath,
        baselineContent: "old",
        documentDirty: true,
        reviewState: "diff_snapshot_preserved",
      }),
    ).resolves.toEqual({
      save_failure: {
        document_dirty: true,
        disk_state: "unchanged",
        concurrent_change: false,
        review_state: "diff_snapshot_preserved",
        dirty_document_state: "unavailable",
        vscode_error_detail: "unavailable",
        retryable: true,
        retry_target: "editor_save",
      },
      next_steps: [
        expect.stringContaining("review snapshot"),
        expect.stringContaining("pre-edit disk baseline"),
      ],
    });
  });

  it("reports whether the dirty editor changed during a failed save", async () => {
    const filePath = await makeFile("old");

    await expect(
      diagnoseEditSaveFailure({
        absolutePath: filePath,
        baselineContent: "old",
        documentDirty: true,
        saveAttemptContent: "proposed content",
        currentDocumentContent: "save participant mutation",
        reviewState: "dirty_document_preserved",
      }),
    ).resolves.toMatchObject({
      save_failure: {
        dirty_document_state: "changed_after_save_attempt",
        retry_target: "editor_save",
      },
      next_steps: [
        expect.stringContaining("changed during the failed save"),
        expect.stringContaining("pre-edit disk baseline"),
      ],
    });
  });

  it("detects a concurrent disk change", async () => {
    const filePath = await makeFile("changed elsewhere");

    await expect(
      diagnoseEditSaveFailure({
        absolutePath: filePath,
        baselineContent: "old",
        documentDirty: true,
        reviewState: "dirty_document_preserved",
      }),
    ).resolves.toMatchObject({
      save_failure: {
        disk_state: "changed",
        concurrent_change: true,
        review_state: "dirty_document_preserved",
      },
      next_steps: [expect.any(String), expect.stringContaining("re-read")],
    });
  });

  it("reports a missing disk target without guessing concurrency", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-save-failure-"),
    );
    tempDirs.push(dir);

    await expect(
      diagnoseEditSaveFailure({
        absolutePath: path.join(dir, "missing.ts"),
        baselineContent: "old",
        documentDirty: true,
        reviewState: "dirty_document_preserved",
      }),
    ).resolves.toMatchObject({
      save_failure: {
        disk_state: "missing",
        concurrent_change: "unknown",
        disk_error_code: "ENOENT",
      },
    });
  });
});

describe("diagnoseEditApplyFailure", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  async function makeFile(content: string): Promise<string> {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-apply-failure-"),
    );
    tempDirs.push(dir);
    const filePath = path.join(dir, "file.ts");
    await fs.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  it("reports an unchanged disk and matching document baseline", async () => {
    const filePath = await makeFile("baseline");

    await expect(
      diagnoseEditApplyFailure({
        absolutePath: filePath,
        baselineContent: "baseline",
        document: { getText: () => "baseline", isDirty: false },
      }),
    ).resolves.toEqual({
      apply_failure: {
        document_dirty: false,
        document_state: "matches_baseline",
        disk_state: "unchanged",
        concurrent_change: false,
        retryable: true,
      },
      next_steps: [expect.stringContaining("rejected the editor apply")],
    });
  });

  it("treats BOM and EOL-normalized editor content as matching the baseline", async () => {
    const filePath = await makeFile("\uFEFFbaseline\r\n");

    await expect(
      diagnoseEditApplyFailure({
        absolutePath: filePath,
        baselineContent: "\uFEFFbaseline\r\n",
        document: { getText: () => "baseline\n", isDirty: false },
      }),
    ).resolves.toMatchObject({
      apply_failure: {
        document_dirty: false,
        document_state: "matches_baseline",
        disk_state: "unchanged",
        concurrent_change: false,
      },
    });
  });

  it("reports concurrent disk drift and a divergent dirty document", async () => {
    const filePath = await makeFile("changed elsewhere");

    await expect(
      diagnoseEditApplyFailure({
        absolutePath: filePath,
        baselineContent: "baseline",
        document: { getText: () => "unsaved editor content", isDirty: true },
      }),
    ).resolves.toEqual({
      apply_failure: {
        document_dirty: true,
        document_state: "differs_from_baseline",
        disk_state: "changed",
        concurrent_change: true,
        retryable: true,
      },
      next_steps: [expect.stringContaining("changed on disk")],
    });
  });

  it("reports a missing file without guessing document state", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-apply-failure-"),
    );
    tempDirs.push(dir);

    await expect(
      diagnoseEditApplyFailure({
        absolutePath: path.join(dir, "missing.ts"),
        baselineContent: "baseline",
      }),
    ).resolves.toEqual({
      apply_failure: {
        document_dirty: "unavailable",
        document_state: "unavailable",
        disk_state: "missing",
        concurrent_change: "unknown",
        retryable: true,
      },
      next_steps: [expect.stringContaining("rejected the editor apply")],
    });
  });
});

describe("DiffViewProvider rollback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    (vscode.workspace.textDocuments as unknown[]).length = 0;
  });

  it("does not save the proposed buffer when rollback application fails", async () => {
    const save = vi.fn(async () => true);
    const document = {
      uri: { scheme: "file", fsPath: "/workspace/file.ts" },
      isDirty: true,
      lineCount: 1,
      save,
    };
    (vscode.workspace.textDocuments as unknown[]).push(document);
    vi.spyOn(vscode.workspace, "applyEdit").mockResolvedValue(false);
    const provider = new DiffViewProvider(0, "failed-revert");
    Object.assign(provider, {
      absolutePath: "/workspace/file.ts",
      relPath: "file.ts",
      originalContent: "original",
      editType: "modify",
    });

    await expect(provider.revertChanges("Rejected")).resolves.toEqual({
      status: "rejected",
      path: "file.ts",
      reason: "revert_apply_failed",
      next_steps: [expect.stringContaining("preserved")],
    });
    expect(save).not.toHaveBeenCalled();
  });
});

describe("withFileLock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("acquires lock, runs fn, and returns its value", async () => {
    const result = await withFileLock(uniquePath(), async () => "hello");
    expect(result).toBe("hello");
  });

  it("forwards non-string return types", async () => {
    const result = await withFileLock(uniquePath(), async () => 42);
    expect(result).toBe(42);
  });

  it("serializes concurrent locks on the same path", async () => {
    const path = uniquePath();
    const order: number[] = [];

    const p1 = withFileLock(path, async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
    });
    const p2 = withFileLock(path, async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("does not block different paths", async () => {
    const order: number[] = [];

    const p1 = withFileLock(uniquePath(), async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
    });
    const p2 = withFileLock(uniquePath(), async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    // p2 should complete before p1 since they're on different paths
    expect(order).toEqual([2, 1]);
  });

  it("releases lock after fn throws", async () => {
    const path = uniquePath();

    // First call throws
    await expect(
      withFileLock(path, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Second call should succeed (not deadlocked)
    const result = await withFileLock(path, async () => "recovered");
    expect(result).toBe("recovered");
  });

  it("timeout does not strand subsequent callers (regression)", async () => {
    vi.useFakeTimers();
    const path = uniquePath();

    // Lock A: never resolves — simulates a hung operation
    let resolveA: () => void;
    const lockA = withFileLock(
      path,
      () =>
        new Promise<void>((r) => {
          resolveA = r;
        }),
    );

    // Lock B: queued behind A
    const lockB = withFileLock(path, async () => "B");

    // Lock C: queued behind B
    const lockC = withFileLock(path, async () => "C");

    // Attach rejection/resolution handlers BEFORE advancing timers so
    // lockB's rejection is never "unhandled" during the timer tick.
    const expectB = expect(lockB).rejects.toThrow("Lock timeout");
    const expectC = expect(lockC).resolves.toBe("C");

    // Advance past the 60s timeout — B should timeout, C should proceed
    await vi.advanceTimersByTimeAsync(61_000);
    await expectB;

    // C should proceed (not strand forever) because B's timeout
    // resolved B's lockPromise, unblocking C. Before the fix, B's
    // promise was never resolved and C would be stuck forever.
    await expectC;

    // Clean up: resolve A so it doesn't leak
    resolveA!();
    await vi.advanceTimersByTimeAsync(1);
    await lockA.catch(() => {}); // ignore if it rejects
  });
});
