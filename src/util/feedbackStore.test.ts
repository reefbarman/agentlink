import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FeedbackLookupError,
  FeedbackRecordError,
  MAX_FEEDBACK_RECORD_BYTES,
  appendFeedback,
  deleteFeedback,
  readFeedback,
  readFeedbackContent,
  triageFeedback,
} from "./feedbackStore.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FeedbackEntry } from "./feedbackStore.js";
import { buildSync } from "esbuild";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

let tmpHome: string;
let feedbackPath: string;
let legacyTombstonePath: string;
let tombstoneDirectory: string;
let triagePath: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

function makeEntry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    timestamp: new Date().toISOString(),
    tool_name: "test_tool",
    feedback: "test feedback",
    extension_version: "0.0.1",
    ...overrides,
  };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-feedback-home-"));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  feedbackPath = path.join(tmpHome, ".agentlink", "agentlink-feedback.jsonl");
  legacyTombstonePath = path.join(
    tmpHome,
    ".agentlink",
    "agentlink-feedback-deletions.jsonl",
  );
  tombstoneDirectory = path.join(
    tmpHome,
    ".agentlink",
    "agentlink-feedback-deletions",
  );
  triagePath = path.join(
    tmpHome,
    ".agentlink",
    "agentlink-feedback-triage.jsonl",
  );
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("feedbackStore", () => {
  it("assigns stable IDs and global indices to appended entries", () => {
    const appended = appendFeedback(makeEntry({ feedback: "works great" }));
    const entries = readFeedback();

    expect(appended.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entries).toEqual([
      expect.objectContaining({
        id: appended.id,
        global_index: 0,
        feedback: "works great",
        tool_name: "test_tool",
      }),
    ]);
  });

  it("preserves impact context alongside older records without rewriting them", () => {
    const legacy = makeEntry({ timestamp: "2026-01-01T00:00:00.000Z" });
    fs.mkdirSync(path.dirname(feedbackPath), { recursive: true });
    const legacyLine = JSON.stringify(legacy) + "\n";
    fs.writeFileSync(feedbackPath, legacyLine, "utf-8");
    const [before] = readFeedback();
    const context = {
      observed_impact: "Task blocked until a direct read succeeded",
      workaround: "Used read_file, task completed with one extra call",
      observed_recurrence: "Two failures in three attempts this session",
      improvement_signal: "First attempt returns usable content",
      category: "bug" as const,
      suspected_cause: "The indexed content may be stale",
      suggested_change: "Refresh the stale entry before returning it",
    };
    const appended = appendFeedback(makeEntry(context));
    triageFeedback({ ids: [before!.id], triaged: true, priority: "P2" });
    const [oldRecord, newRecord] = readFeedback();

    expect(oldRecord).toMatchObject({
      id: before!.id,
      global_index: 0,
      priority: "P2",
    });
    for (const field of [
      "observed_impact",
      "category",
      "suspected_cause",
      "suggested_change",
    ]) {
      expect(oldRecord).not.toHaveProperty(field);
    }
    expect(newRecord).toMatchObject({
      ...context,
      id: appended.id,
      global_index: 1,
    });
    expect(fs.readFileSync(feedbackPath, "utf-8").startsWith(legacyLine)).toBe(
      true,
    );
  });

  it("preserves global indices when filtering", () => {
    appendFeedback(makeEntry({ tool_name: "tool_a", feedback: "a" }));
    const second = appendFeedback(
      makeEntry({ tool_name: "tool_b", feedback: "b" }),
    );

    expect(readFeedback("tool_b")).toEqual([
      expect.objectContaining({ id: second.id, global_index: 1 }),
    ]);
  });

  it("returns stable distinct IDs for duplicate legacy lines across formatting and EOL changes", () => {
    const entry = makeEntry({ feedback: "legacy" });
    const compact = JSON.stringify(entry);
    fs.mkdirSync(path.dirname(feedbackPath), { recursive: true });
    fs.writeFileSync(feedbackPath, `${compact}\r\n${compact}\r\n`, "utf-8");

    const firstRead = readFeedback();
    fs.writeFileSync(
      feedbackPath,
      `${JSON.stringify(entry, null, 0)}\n${JSON.stringify(entry, null, 0)}\n`,
      "utf-8",
    );
    const secondRead = readFeedback();

    expect(firstRead.map((record) => record.id)).toEqual(
      secondRead.map((record) => record.id),
    );
    expect(new Set(firstRead.map((record) => record.id))).toHaveLength(2);
    expect(firstRead.every((record) => record.id.startsWith("legacy-"))).toBe(
      true,
    );
  });

  it("returns an empty array when no file exists", () => {
    expect(readFeedback()).toEqual([]);
  });

  it("byte-bounds serialized entries for atomic append", () => {
    appendFeedback(
      makeEntry({
        feedback: '🌊\n"'.repeat(5000),
        tool_params: "p".repeat(1000),
        observed_impact: "🌊".repeat(1000),
        workaround: '🌊\n"'.repeat(1000),
        observed_recurrence: "r".repeat(1000),
        improvement_signal: "s".repeat(1000),
      }),
    );
    const [entry] = readFeedback();
    const [line] = fs.readFileSync(feedbackPath, "utf-8").split("\n");

    expect(entry?.feedback.length).toBeLessThan(5000);
    expect(entry?.feedback).toContain("…(truncated)");
    expect(entry?.tool_params?.length).toBeLessThanOrEqual(520);
    for (const field of [
      "observed_impact",
      "workaround",
      "observed_recurrence",
      "improvement_signal",
    ] as const) {
      expect(entry?.[field]?.length).toBeGreaterThan(0);
      expect(entry?.[field]?.length).toBeLessThanOrEqual(520);
      expect(entry?.[field]).toContain("…(truncated)");
    }
    expect(Buffer.byteLength(`${line}\n`, "utf-8")).toBeLessThanOrEqual(4000);
  });

  it("trims proposals before sacrificing existing bug evidence at the byte limit", () => {
    const evidence = {
      feedback: "f".repeat(1800),
      observed_impact: "i".repeat(400),
      workaround: "w".repeat(300),
      observed_recurrence: "r".repeat(200),
      tool_params: "p".repeat(300),
      tool_result_summary: "e".repeat(300),
    };
    const entry = appendFeedback(
      makeEntry({
        ...evidence,
        category: "bug",
        suspected_cause: "🌊".repeat(1000),
        suggested_change: '🌊\n"'.repeat(1000),
      }),
    );
    expect(entry).toMatchObject(evidence);
    expect(entry.category).toBe("bug");
    expect(entry.suspected_cause?.length ?? 0).toBeLessThan(520);
    expect(entry.suggested_change?.length ?? 0).toBeLessThan(520);
    expect(
      Buffer.byteLength(fs.readFileSync(feedbackPath, "utf-8"), "utf-8"),
    ).toBeLessThanOrEqual(4000);
  });

  it("still bounds oversized evidence when proposal fields have been omitted", () => {
    const entry = appendFeedback(
      makeEntry({
        feedback: "🌊".repeat(5000),
        suspected_cause: "Small hypothesis",
        suggested_change: "Small proposal",
      }),
    );
    expect(entry.suspected_cause).toBeUndefined();
    expect(entry.suggested_change).toBeUndefined();
    expect(entry.feedback).toContain("…(truncated)");
    expect(
      Buffer.byteLength(fs.readFileSync(feedbackPath, "utf-8"), "utf-8"),
    ).toBeLessThanOrEqual(4000);
  });

  it("projects triage metadata without modifying raw feedback", () => {
    const entry = appendFeedback(makeEntry({ feedback: "accept me" }));
    const primaryBefore = fs.readFileSync(feedbackPath, "utf-8");

    const result = triageFeedback({
      ids: [entry.id],
      triaged: true,
      priority: "P1",
    });

    expect(result).toEqual({
      updated: [
        expect.objectContaining({
          id: entry.id,
          triaged: true,
          priority: "P1",
          triaged_at: expect.any(String),
        }),
      ],
      unknown_ids: [],
    });
    expect(fs.readFileSync(feedbackPath, "utf-8")).toBe(primaryBefore);
    expect(
      fs.readFileSync(triagePath, "utf-8").trim().split("\n"),
    ).toHaveLength(1);
  });

  it("reprioritizes feedback and clears priority when untriaged", () => {
    const entry = appendFeedback(makeEntry());
    triageFeedback({ ids: [entry.id], triaged: true, priority: "P2" });
    triageFeedback({ ids: [entry.id], triaged: true, priority: "P0" });

    expect(readFeedback()).toEqual([
      expect.objectContaining({
        id: entry.id,
        triaged: true,
        priority: "P0",
      }),
    ]);

    triageFeedback({ ids: [entry.id], triaged: false });

    expect(readFeedback()).toEqual([
      expect.objectContaining({
        id: entry.id,
        triaged: false,
        priority: undefined,
        triaged_at: undefined,
      }),
    ]);
  });

  it("filters by tool, triage state, and priority", () => {
    const p0 = appendFeedback(
      makeEntry({ tool_name: "tool_a", feedback: "p0" }),
    );
    const p2 = appendFeedback(
      makeEntry({ tool_name: "tool_a", feedback: "p2" }),
    );
    appendFeedback(makeEntry({ tool_name: "tool_b", feedback: "new" }));
    triageFeedback({ ids: [p0.id], triaged: true, priority: "P0" });
    triageFeedback({ ids: [p2.id], triaged: true, priority: "P2" });

    expect(
      readFeedback({
        tool_name: "tool_a",
        triaged: true,
        priorities: ["P0"],
      }).map((entry) => entry.id),
    ).toEqual([p0.id]);
    expect(readFeedback({ triaged: false })).toEqual([
      expect.objectContaining({ tool_name: "tool_b", triaged: false }),
    ]);
    expect(readFeedback({ priorities: ["P0", "P2"] })).toHaveLength(2);
  });

  it("validates triage invariants and reports unknown IDs", () => {
    const entry = appendFeedback(makeEntry());

    expect(() => triageFeedback({ ids: [entry.id], triaged: true })).toThrow(
      /requires a priority/,
    );
    expect(() =>
      triageFeedback({ ids: [entry.id], triaged: false, priority: "P1" }),
    ).toThrow(/cannot have a priority/);
    expect(() => triageFeedback({ ids: [], triaged: false })).toThrow(
      /non-empty array/,
    );
    expect(
      triageFeedback({
        ids: [entry.id, "missing-id"],
        triaged: true,
        priority: "P3",
      }),
    ).toEqual({
      updated: [expect.objectContaining({ id: entry.id, priority: "P3" })],
      unknown_ids: ["missing-id"],
    });
  });

  it("uses append order and skips malformed triage metadata", () => {
    const entry = appendFeedback(makeEntry());
    triageFeedback({ ids: [entry.id], triaged: true, priority: "P2" });
    fs.appendFileSync(triagePath, "not json\n", "utf-8");
    triageFeedback({ ids: [entry.id], triaged: true, priority: "P0" });

    expect(readFeedback()).toEqual([
      expect.objectContaining({ id: entry.id, triaged: true, priority: "P0" }),
    ]);
    expect(
      fs.readFileSync(triagePath, "utf-8").trim().split("\n"),
    ).toHaveLength(3);
  });

  it("deletes by stable ID using append-only tombstones", () => {
    const keep = appendFeedback(makeEntry({ feedback: "keep" }));
    const remove = appendFeedback(makeEntry({ feedback: "delete me" }));
    const primaryBefore = fs.readFileSync(feedbackPath, "utf-8");

    const result = deleteFeedback({ ids: [remove.id] });

    expect(result.removed).toEqual([
      expect.objectContaining({ id: remove.id, feedback: "delete me" }),
    ]);
    expect(readFeedback()).toEqual([
      expect.objectContaining({ id: keep.id, feedback: "keep" }),
    ]);
    expect(fs.readFileSync(feedbackPath, "utf-8")).toBe(primaryBefore);
    const tombstones = fs.readdirSync(tombstoneDirectory);
    expect(tombstones).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(tombstoneDirectory, tombstones[0]!), "utf-8"),
    ).toContain(remove.id);
  });

  it("keeps appends made after a deletion snapshot", () => {
    const remove = appendFeedback(makeEntry({ feedback: "remove" }));
    deleteFeedback({ ids: [remove.id] });
    const later = appendFeedback(makeEntry({ feedback: "later append" }));

    expect(readFeedback()).toEqual([
      expect.objectContaining({ id: later.id, feedback: "later append" }),
    ]);
  });

  it("keeps legacy global indices stable after deletion", () => {
    const first = appendFeedback(makeEntry({ feedback: "first" }));
    appendFeedback(makeEntry({ feedback: "second" }));
    const third = appendFeedback(makeEntry({ feedback: "third" }));

    expect(deleteFeedback({ indices: [0] }).removed[0]?.id).toBe(first.id);
    expect(
      readFeedback().map(({ id, global_index }) => ({ id, global_index })),
    ).toEqual([
      { id: expect.any(String), global_index: 1 },
      { id: third.id, global_index: 2 },
    ]);
    expect(deleteFeedback({ indices: [2] }).removed[0]?.id).toBe(third.id);
  });

  it("honors valid legacy tombstones", () => {
    const line = JSON.stringify(makeEntry({ feedback: "legacy deleted" }));
    fs.mkdirSync(path.dirname(feedbackPath), { recursive: true });
    fs.writeFileSync(feedbackPath, `${line}\n`, "utf-8");
    const [entry] = readFeedback();
    fs.writeFileSync(
      legacyTombstonePath,
      `${JSON.stringify({ id: entry?.id, deleted_at: new Date().toISOString() })}\n`,
      "utf-8",
    );

    expect(readFeedback()).toEqual([]);
    expect(deleteFeedback({ ids: [entry!.id] }).already_deleted_ids).toEqual([
      entry!.id,
    ]);
  });

  it("reports idempotent IDs and unknown IDs and indices explicitly", () => {
    const entry = appendFeedback(makeEntry());
    deleteFeedback({ ids: [entry.id] });

    const result = deleteFeedback({ ids: [entry.id, "missing-id"] });

    expect(result.removed).toEqual([]);
    expect(result.already_deleted_ids).toEqual([entry.id]);
    expect(result.unknown_ids).toEqual(["missing-id"]);
    expect(result.unknown_indices).toEqual([]);
    expect(deleteFeedback({ indices: [999] }).unknown_indices).toEqual([999]);
  });

  it("rejects mixed, missing, and empty deletion selectors", () => {
    expect(() => deleteFeedback({ ids: [], indices: [] })).toThrow(
      /exactly one/,
    );
    expect(() => deleteFeedback({})).toThrow(/exactly one/);
    expect(() => deleteFeedback({ ids: [] })).toThrow(/non-empty array/);
    expect(() => deleteFeedback({ ids: [" "] })).toThrow(/non-empty strings/);
    expect(() => deleteFeedback({ indices: [] })).toThrow(/non-empty array/);
  });

  describe("complete content preservation", () => {
    const longReport = () =>
      makeEntry({
        feedback:
          'Long report 🌊 with "quotes"\nand newlines. '.repeat(120) +
          "TAIL-CONSTRAINT Supersedes: id-one; id-two",
        suspected_cause: "Hypothesis ".repeat(200) + "CAUSE-TAIL",
        suggested_change: "Proposal ".repeat(200) + "CHANGE-TAIL",
        observed_impact: "Impact ".repeat(150) + "IMPACT-TAIL",
        workaround: "Workaround",
        tool_params: JSON.stringify({ path: "x".repeat(900) }) + "PARAMS-TAIL",
        tool_result_summary: "🌊".repeat(700) + "RESULT-TAIL",
        category: "bug",
        session_id: "session-x",
        workspace: "project-x",
      });

    function contentDirectory() {
      return path.join(tmpHome, ".agentlink", "agentlink-feedback-content");
    }

    function overflowPath(id: string) {
      return path.join(
        contentDirectory(),
        `${createHash("sha256").update(id).digest("hex")}.json`,
      );
    }

    it("keeps a bounded preview and returns the exact full record", () => {
      const submitted = longReport();
      const appended = appendFeedback(submitted);
      const [line] = fs.readFileSync(feedbackPath, "utf-8").split("\n");

      expect(Buffer.byteLength(`${line}\n`, "utf-8")).toBeLessThanOrEqual(4000);
      expect(appended.content_status).toBe("preview");
      expect(appended.content_capture).toMatchObject({
        version: 1,
        storage: "overflow",
        truncated_fields: expect.arrayContaining([
          "feedback",
          "suspected_cause",
          "suggested_change",
        ]),
      });
      expect(fs.statSync(overflowPath(appended.id)).mode & 0o777).toBe(0o600);

      const full = readFeedbackContent(appended.id);
      expect(full.content_status).toBe("complete");
      expect(full.content).toEqual({ ...submitted, id: appended.id });
      expect(full.content.feedback).toContain(
        "TAIL-CONSTRAINT Supersedes: id-one; id-two",
      );
      expect(full.sha256).toBe(appended.content_capture?.sha256);
      expect(readFeedback()[0]).toMatchObject({
        id: appended.id,
        content_status: "preview",
      });
    });

    it("stores small reports inline without an overflow file", () => {
      const submitted = makeEntry({ observed_impact: "small" });
      const appended = appendFeedback(submitted);

      expect(appended.content_status).toBe("complete");
      expect(appended.content_capture).toMatchObject({
        storage: "inline",
        truncated_fields: [],
      });
      expect(fs.existsSync(contentDirectory())).toBe(false);
      expect(readFeedbackContent(appended.id).content).toEqual({
        ...submitted,
        id: appended.id,
      });
    });

    it("overflows a single field above its preview cap even when the line is small", () => {
      const appended = appendFeedback(
        makeEntry({ workaround: "w".repeat(600) }),
      );
      expect(appended.content_capture?.truncated_fields).toEqual([
        "workaround",
      ]);
      expect(readFeedbackContent(appended.id).content.workaround).toBe(
        "w".repeat(600),
      );
    });

    it("rejects records above the ceiling before writing anything", () => {
      let caught: unknown;
      try {
        appendFeedback(
          makeEntry({
            tool_result_summary: "r".repeat(MAX_FEEDBACK_RECORD_BYTES),
          }),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FeedbackRecordError);
      expect((caught as FeedbackRecordError).code).toBe("feedback_too_large");
      expect((caught as FeedbackRecordError).details).toMatchObject({
        max_bytes: MAX_FEEDBACK_RECORD_BYTES,
        field_bytes: { tool_result_summary: MAX_FEEDBACK_RECORD_BYTES },
      });
      expect(fs.existsSync(feedbackPath)).toBe(false);
      expect(fs.existsSync(contentDirectory())).toBe(false);
    });

    it("rejects oversized identity metadata instead of looping or altering it", () => {
      expect(() =>
        appendFeedback(makeEntry({ tool_name: "t".repeat(5000) })),
      ).toThrow(
        expect.objectContaining({ code: "feedback_metadata_too_large" }),
      );
      expect(fs.existsSync(feedbackPath)).toBe(false);
    });

    it("keeps every new line valid for the old parser with unchanged indices", () => {
      fs.mkdirSync(path.dirname(feedbackPath), { recursive: true });
      fs.writeFileSync(
        feedbackPath,
        `${JSON.stringify(makeEntry({ feedback: "legacy" }))}\n`,
        "utf-8",
      );
      appendFeedback(longReport());
      appendFeedback(makeEntry({ feedback: "🌊".repeat(5000) }));
      appendFeedback(makeEntry());

      // Mirrors the pre-capture reader's validity predicate and index derivation.
      const oldIndices = fs
        .readFileSync(feedbackPath, "utf-8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
        .filter(
          (entry) =>
            typeof entry.timestamp === "string" &&
            typeof entry.tool_name === "string" &&
            typeof entry.feedback === "string" &&
            typeof entry.extension_version === "string",
        )
        .map((_entry, index) => index);
      expect(oldIndices).toEqual(
        readFeedback().map((entry) => entry.global_index),
      );
      expect(readFeedback().map((entry) => entry.content_status)).toEqual([
        "legacy_unverified",
        "preview",
        "preview",
        "complete",
      ]);
    });

    it("labels legacy, unsupported and malformed capture without claiming completeness", () => {
      fs.mkdirSync(path.dirname(feedbackPath), { recursive: true });
      const base = makeEntry({ feedback: "retained" });
      const lines = [
        { ...base, id: "legacy-entry" },
        {
          ...base,
          id: "future-entry",
          content_capture: { version: 2, storage: "elsewhere" },
        },
        {
          ...base,
          id: "broken-entry",
          content_capture: { version: 1, storage: "overflow" },
        },
      ];
      fs.writeFileSync(
        feedbackPath,
        lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
        "utf-8",
      );

      expect(readFeedbackContent("legacy-entry")).toMatchObject({
        content_status: "legacy_unverified",
        content: { feedback: "retained" },
      });
      expect(readFeedbackContent("future-entry").content_status).toBe(
        "unsupported_capture",
      );
      expect(() => readFeedbackContent("broken-entry")).toThrow(
        expect.objectContaining({ code: "invalid_capture" }),
      );
    });

    it("keeps unknown retained fields for legacy and newer-capture records", () => {
      fs.mkdirSync(path.dirname(feedbackPath), { recursive: true });
      const base = makeEntry({ feedback: "retained" });
      const lines = [
        { ...base, id: "legacy-extra", future_field: { nested: 1 } },
        {
          ...base,
          id: "future-extra",
          content_capture: { version: 2 },
          future_field: "FUTURE-VALUE",
        },
      ];
      fs.writeFileSync(
        feedbackPath,
        lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
        "utf-8",
      );

      const legacy = readFeedbackContent("legacy-extra");
      expect(legacy.content).toMatchObject({ future_field: { nested: 1 } });
      expect(legacy.content).not.toHaveProperty("global_index");
      const future = readFeedbackContent("future-extra");
      expect(future.content).toMatchObject({ future_field: "FUTURE-VALUE" });
      expect(future.content).not.toHaveProperty("content_capture");
      expect(future.content).not.toHaveProperty("triaged");
    });

    it("does not label a tampered inline line complete in list projections", () => {
      const appended = appendFeedback(makeEntry({ feedback: "original" }));
      const raw = fs.readFileSync(feedbackPath, "utf-8");
      fs.writeFileSync(feedbackPath, raw.replace("original", "tampered"));

      expect(readFeedback()[0]).toMatchObject({
        id: appended.id,
        content_status: "invalid_capture",
      });
      expect(() => readFeedbackContent(appended.id)).toThrow(
        expect.objectContaining({ code: "invalid_capture" }),
      );
    });

    it("refuses a symlinked content directory for writes and reads", () => {
      const appended = appendFeedback(longReport());
      const elsewhere = path.join(tmpHome, "elsewhere-content");
      fs.renameSync(contentDirectory(), elsewhere);
      fs.symlinkSync(elsewhere, contentDirectory());

      expect(() => readFeedbackContent(appended.id)).toThrow(
        expect.objectContaining({ code: "content_unavailable" }),
      );
      const before = fs.readFileSync(feedbackPath, "utf-8");
      expect(() => appendFeedback(longReport())).toThrow(
        expect.objectContaining({ code: "feedback_storage_failed" }),
      );
      expect(fs.readFileSync(feedbackPath, "utf-8")).toBe(before);
    });

    it("rejects an overflow file that grew beyond its recorded size", () => {
      const appended = appendFeedback(longReport());
      const target = overflowPath(appended.id);
      fs.chmodSync(target, 0o600);
      fs.appendFileSync(target, " ".repeat(64), "utf-8");
      expect(() => readFeedbackContent(appended.id)).toThrow(
        expect.objectContaining({ code: "content_unavailable" }),
      );
    });

    it.each(["missing", "corrupted", "symlink"] as const)(
      "reports %s overflow content as unavailable, never as complete",
      (fault) => {
        const appended = appendFeedback(longReport());
        const target = overflowPath(appended.id);
        if (fault === "missing") fs.rmSync(target);
        if (fault === "corrupted") {
          const raw = fs.readFileSync(target, "utf-8");
          fs.chmodSync(target, 0o600);
          fs.writeFileSync(target, raw.replace("TAIL", "FAKE"), "utf-8");
        }
        if (fault === "symlink") {
          const elsewhere = path.join(tmpHome, "elsewhere.json");
          fs.copyFileSync(target, elsewhere);
          fs.rmSync(target);
          fs.symlinkSync(elsewhere, target);
        }
        let caught: unknown;
        try {
          readFeedbackContent(appended.id);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(FeedbackLookupError);
        expect(caught).toMatchObject({
          code: "content_unavailable",
          record: { id: appended.id, content_status: "preview" },
        });
      },
    );

    it("rejects unknown, hidden and duplicate IDs explicitly", () => {
      const hidden = appendFeedback(makeEntry());
      deleteFeedback({ ids: [hidden.id] });
      expect(() => readFeedbackContent(hidden.id)).toThrow(
        expect.objectContaining({ code: "not_found" }),
      );
      expect(() => readFeedbackContent("missing")).toThrow(
        expect.objectContaining({ code: "not_found" }),
      );
      const line = JSON.stringify({ ...makeEntry(), id: "duplicate-id" });
      fs.appendFileSync(feedbackPath, `${line}\n${line}\n`, "utf-8");
      expect(() => readFeedbackContent("duplicate-id")).toThrow(
        expect.objectContaining({ code: "ambiguous_record" }),
      );
    });

    it("does not publish an index entry when overflow storage fails", () => {
      fs.mkdirSync(path.dirname(contentDirectory()), { recursive: true });
      fs.writeFileSync(contentDirectory(), "not a directory", "utf-8");
      expect(() => appendFeedback(longReport())).toThrow(
        expect.objectContaining({ code: "feedback_storage_failed" }),
      );
      expect(fs.existsSync(feedbackPath)).toBe(false);
    });

    it("reports an unknown recording state with the ID when the append fails", () => {
      fs.mkdirSync(feedbackPath, { recursive: true });
      let caught: unknown;
      try {
        appendFeedback(makeEntry());
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: "feedback_recording_unknown",
        details: { id: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      });
    });

    it("preserves full content and stable indices across triage and deletion", () => {
      const first = appendFeedback(longReport());
      const second = appendFeedback(longReport());
      triageFeedback({ ids: [first.id], triaged: true, priority: "P2" });
      const triaged = readFeedbackContent(first.id);
      expect(triaged.record.priority).toBe("P2");
      expect(triaged.sha256).toBe(first.content_capture?.sha256);
      deleteFeedback({ ids: [first.id] });
      expect(fs.existsSync(overflowPath(first.id))).toBe(true);
      expect(readFeedback()).toEqual([
        expect.objectContaining({ id: second.id, global_index: 1 }),
      ]);
    });

    it("keeps independent complete records from concurrent writer processes", async () => {
      const bundle = path.join(tmpHome, "feedbackStore.cjs");
      buildSync({
        entryPoints: [path.join(__dirname, "feedbackStore.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: bundle,
        logLevel: "silent",
      });
      const writers = 4;
      const perWriter = 5;
      const script = `
        const store = require(${JSON.stringify(bundle)});
        const writer = process.argv[1];
        for (let i = 0; i < ${perWriter}; i++) {
          store.appendFeedback({
            timestamp: new Date().toISOString(),
            tool_name: "parallel",
            feedback: "writer " + writer + " report " + i + " ".repeat(3000) + "END",
            suggested_change: "x".repeat(900) + writer,
            extension_version: "0.0.1",
          });
        }`;
      await Promise.all(
        Array.from(
          { length: writers },
          (_, writer) =>
            new Promise<void>((resolve, reject) => {
              const child = spawn(
                process.execPath,
                ["-e", script, String(writer)],
                {
                  env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
                  stdio: ["ignore", "ignore", "pipe"],
                },
              );
              let stderr = "";
              child.stderr.on("data", (chunk) => (stderr += chunk));
              child.on("error", reject);
              child.on("exit", (code) =>
                code === 0 ? resolve() : reject(new Error(stderr)),
              );
            }),
        ),
      );

      const entries = readFeedback();
      expect(entries).toHaveLength(writers * perWriter);
      expect(new Set(entries.map((entry) => entry.id)).size).toBe(
        writers * perWriter,
      );
      expect(entries.map((entry) => entry.global_index)).toEqual(
        entries.map((_entry, index) => index),
      );
      for (const entry of entries) {
        const full = readFeedbackContent(entry.id);
        expect(full.content.feedback).toMatch(/END$/);
        expect(full.content.suggested_change).toHaveLength(901);
      }
    });
  });

  it("skips malformed primary and tombstone lines", () => {
    fs.mkdirSync(path.dirname(feedbackPath), { recursive: true });
    fs.writeFileSync(
      feedbackPath,
      '{"timestamp":"t","tool_name":"x","feedback":"good","extension_version":"1"}\nnot json\n',
      "utf-8",
    );
    fs.writeFileSync(legacyTombstonePath, "not json\n", "utf-8");

    expect(readFeedback()).toEqual([
      expect.objectContaining({ feedback: "good", global_index: 0 }),
    ]);
  });
});
