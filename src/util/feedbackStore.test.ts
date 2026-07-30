import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFeedback,
  deleteFeedback,
  readFeedback,
  triageFeedback,
} from "./feedbackStore.js";

import type { FeedbackEntry } from "./feedbackStore.js";

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
      }),
    );
    const [entry] = readFeedback();
    const [line] = fs.readFileSync(feedbackPath, "utf-8").split("\n");

    expect(entry?.feedback.length).toBeLessThan(5000);
    expect(entry?.feedback).toContain("…(truncated)");
    expect(entry?.tool_params?.length).toBeLessThanOrEqual(520);
    expect(Buffer.byteLength(`${line}\n`, "utf-8")).toBeLessThanOrEqual(4000);
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
