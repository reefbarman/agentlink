import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFormatOnSaveReport,
  createUserEditsPatch,
  isIgnorableTabCloseError,
} from "./DiffViewProvider.js";

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
