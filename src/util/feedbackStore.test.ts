import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { appendFeedback, readFeedback, deleteFeedback } from "./feedbackStore.js";
import type { FeedbackEntry } from "./feedbackStore.js";

// Override the feedback path for testing by mocking the module-level constant.
// feedbackStore uses a hardcoded path, so we mock the fs module to redirect.
let tmpDir: string;
let feedbackPath: string;
const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;
const originalWriteFileSync = fs.writeFileSync;
const originalAppendFileSync = fs.appendFileSync;
const originalMkdirSync = fs.mkdirSync;
const originalUnlinkSync = fs.unlinkSync;
const originalRenameSync = fs.renameSync;

function makeEntry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    timestamp: new Date().toISOString(),
    tool_name: "test_tool",
    feedback: "test feedback",
    extension_version: "0.0.1",
    ...overrides,
  };
}

// Since feedbackStore uses a hardcoded FEEDBACK_PATH, we test its logic
// by calling it against the real path. To keep tests isolated, we save/restore.
let savedContent: string | null = null;

beforeEach(() => {
  feedbackPath = path.join(os.homedir(), ".claude", "native-claude-feedback.jsonl");
  // Save existing file if present
  try {
    savedContent = fs.readFileSync(feedbackPath, "utf-8");
  } catch {
    savedContent = null;
  }
  // Clear it
  try {
    fs.writeFileSync(feedbackPath, "", "utf-8");
  } catch {
    // Directory might not exist — appendFeedback creates it
  }
});

afterEach(() => {
  // Restore original content
  if (savedContent !== null) {
    fs.writeFileSync(feedbackPath, savedContent, "utf-8");
  } else {
    try {
      fs.unlinkSync(feedbackPath);
    } catch {
      // ignore
    }
  }
});

describe("feedbackStore", () => {
  it("appends and reads a feedback entry", () => {
    const entry = makeEntry({ feedback: "works great" });
    appendFeedback(entry);
    const entries = readFeedback();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const last = entries[entries.length - 1];
    expect(last.feedback).toBe("works great");
    expect(last.tool_name).toBe("test_tool");
  });

  it("appends multiple entries", () => {
    appendFeedback(makeEntry({ feedback: "first" }));
    appendFeedback(makeEntry({ feedback: "second" }));
    const entries = readFeedback();
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by tool_name", () => {
    appendFeedback(makeEntry({ tool_name: "tool_a", feedback: "a" }));
    appendFeedback(makeEntry({ tool_name: "tool_b", feedback: "b" }));
    const filtered = readFeedback("tool_a");
    expect(filtered.every((e) => e.tool_name === "tool_a")).toBe(true);
  });

  it("returns empty array when no file exists", () => {
    try { fs.unlinkSync(feedbackPath); } catch { /* */ }
    expect(readFeedback()).toEqual([]);
  });

  it("truncates long feedback", () => {
    const longFeedback = "x".repeat(5000);
    appendFeedback(makeEntry({ feedback: longFeedback }));
    const entries = readFeedback();
    const last = entries[entries.length - 1];
    expect(last.feedback.length).toBeLessThan(5000);
    expect(last.feedback).toContain("…(truncated)");
  });

  it("truncates long tool_params", () => {
    appendFeedback(makeEntry({ tool_params: "p".repeat(1000) }));
    const entries = readFeedback();
    const last = entries[entries.length - 1];
    expect(last.tool_params!.length).toBeLessThanOrEqual(520); // 500 + "…(truncated)"
  });

  it("deletes entries by index", () => {
    appendFeedback(makeEntry({ feedback: "keep" }));
    appendFeedback(makeEntry({ feedback: "delete me" }));
    appendFeedback(makeEntry({ feedback: "also keep" }));
    const removed = deleteFeedback([1]);
    expect(removed).toBe(1);
    const remaining = readFeedback();
    expect(remaining.map((e) => e.feedback)).toEqual(["keep", "also keep"]);
  });

  it("deletes multiple entries", () => {
    appendFeedback(makeEntry({ feedback: "a" }));
    appendFeedback(makeEntry({ feedback: "b" }));
    appendFeedback(makeEntry({ feedback: "c" }));
    const removed = deleteFeedback([0, 2]);
    expect(removed).toBe(2);
    const remaining = readFeedback();
    expect(remaining.map((e) => e.feedback)).toEqual(["b"]);
  });

  it("returns 0 when deleting from nonexistent file", () => {
    try { fs.unlinkSync(feedbackPath); } catch { /* */ }
    expect(deleteFeedback([0])).toBe(0);
  });

  it("skips malformed JSON lines", () => {
    fs.writeFileSync(
      feedbackPath,
      '{"timestamp":"t","tool_name":"x","feedback":"good","extension_version":"1"}\nnot json\n{"timestamp":"t","tool_name":"y","feedback":"also good","extension_version":"1"}\n',
      "utf-8",
    );
    const entries = readFeedback();
    expect(entries).toHaveLength(2);
    expect(entries[0].feedback).toBe("good");
    expect(entries[1].feedback).toBe("also good");
  });
});
