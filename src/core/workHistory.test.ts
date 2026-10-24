import { describe, expect, it } from "vitest";

import {
  hashWorkHistoryContent,
  WorkHistoryJournal,
  type CommittedEditRecord,
} from "./workHistory.js";

function edit(
  fileKey: string,
  before: string | null,
  after: string | null,
  extra: Partial<CommittedEditRecord> = {},
): CommittedEditRecord {
  return {
    fileKey,
    absolutePath: `/repo/${fileKey}`,
    displayPath: fileKey,
    before: { exists: before !== null, content: before ?? "" },
    after: { exists: after !== null, content: after ?? "" },
    ...extra,
  };
}

const freeze = (journal: WorkHistoryJournal, id = "s") =>
  journal.freeze({ id, capturedAt: 1 });

describe("WorkHistoryJournal", () => {
  it("folds a continuous chain of edits into one net diff", async () => {
    const journal = new WorkHistoryJournal();
    journal.record(edit("story.md", null, "a\n"));
    journal.record(edit("story.md", "a\n", "a\nb\n"));

    const summary = await freeze(journal);
    expect(summary?.sessionSameAsSince).toBe(true);
    expect(summary?.session).toBeUndefined();
    const [file] = summary!.sinceSummary.files;
    expect(file).toMatchObject({
      operation: "created",
      editCount: 2,
      diskCheck: "not_checked",
    });
    expect(file!.segments).toEqual([
      {
        added: 2,
        removed: 0,
        hunks: [
          {
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 2,
            lines: ["+a", "+b"],
          },
        ],
      },
    ]);
  });

  it("drops files whose edits returned them to their starting content", async () => {
    const journal = new WorkHistoryJournal();
    journal.record(edit("a.ts", "x", "y"));
    journal.record(edit("a.ts", "y", "x"));
    journal.record(edit("b.ts", "1", "2"));

    const summary = await freeze(journal);
    expect(summary!.sinceSummary.files.map((file) => file.path)).toEqual([
      "b.ts",
    ]);
  });

  it("never merges across a change made outside AgentLink", async () => {
    const journal = new WorkHistoryJournal();
    journal.record(edit("a.ts", "one\n", "two\n"));
    // Someone else changed the file to "user\n" between AgentLink edits.
    journal.record(edit("a.ts", "user\n", "three\n"));

    const [file] = (await freeze(journal))!.sinceSummary.files;
    expect(file!.segments).toHaveLength(2);
    expect(file!.segments.map((segment) => segment.hunks?.[0]?.lines)).toEqual([
      ["-one", "+two"],
      ["-user", "+three"],
    ]);
  });

  it("keeps earlier summaries frozen and scopes each interval separately", async () => {
    const journal = new WorkHistoryJournal();
    journal.record(edit("a.ts", "1\n", "2\n"));
    const first = await freeze(journal, "first");
    const firstSnapshot = JSON.stringify(first);

    journal.record(edit("a.ts", "2\n", "3\n"));
    journal.record(edit("b.ts", null, "new\n"));
    const second = await freeze(journal, "second");

    expect(JSON.stringify(first)).toBe(firstSnapshot);
    expect(second?.sessionSameAsSince).toBeUndefined();
    const since = second!.sinceSummary.files;
    expect(since.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(since[0]!.segments[0]!.hunks?.[0]?.lines).toEqual(["-2", "+3"]);
    const session = second!.session!.files;
    expect(session[0]!.segments[0]!.hunks?.[0]?.lines).toEqual(["-1", "+3"]);
    expect(session[0]!.editCount).toBe(2);
  });

  it("returns an empty since-summary scope with the session scope when only earlier work exists", async () => {
    const journal = new WorkHistoryJournal();
    journal.record(edit("a.ts", "1", "2"));
    await freeze(journal, "first");

    const second = await freeze(journal, "second");
    expect(second?.sinceSummary.files).toEqual([]);
    expect(second?.session?.files).toHaveLength(1);
  });

  it("returns undefined when nothing was captured", async () => {
    const journal = new WorkHistoryJournal();
    journal.noteActivity("shell_commands");
    expect(await freeze(journal)).toBeUndefined();
  });

  it("reports uncaptured activity and disk drift without attributing it", async () => {
    const journal = new WorkHistoryJournal();
    journal.noteActivity("shell_commands");
    journal.record(edit("a.ts", "1", "2"));
    journal.record(edit("b.ts", "1", "2"));
    journal.record(edit("c.ts", "1", "2"));

    const summary = await journal.freeze({
      id: "s",
      capturedAt: 1,
      observe: async (absolutePath) =>
        absolutePath.endsWith("a.ts")
          ? { exists: true, hash: hashWorkHistoryContent(true, "2") }
          : absolutePath.endsWith("b.ts")
            ? { exists: true, hash: hashWorkHistoryContent(true, "formatted") }
            : { exists: false },
    });
    expect(summary!.sinceSummary.coverageNotes).toEqual(["shell_commands"]);
    expect(
      summary!.sinceSummary.files.map((file) => [file.path, file.diskCheck]),
    ).toEqual([
      ["a.ts", "matches"],
      ["b.ts", "changed"],
      ["c.ts", "missing"],
    ]);
    // The captured diff is unchanged by the drift observation.
    expect(summary!.sinceSummary.files[1]!.segments[0]!.hunks).toBeDefined();
  });

  it("keeps metadata but omits content beyond snapshot and retention limits", async () => {
    const journal = new WorkHistoryJournal({
      maxSnapshotBytes: 10,
      maxRetainedBytes: 12,
    });
    journal.record(edit("big.ts", "small", "x".repeat(11)));
    journal.record(edit("bin.ts", "a", "b\u0000c"));
    journal.record(edit("budget.ts", "abcdefgh", "ijklmnop"));

    const files = (await freeze(journal))!.sinceSummary.files;
    expect(files.map((file) => file.segments[0])).toEqual([
      { omitted: "too_large" },
      { omitted: "binary" },
      { omitted: "content_unavailable" },
    ]);
    expect((await freeze(journal))!.session?.coverageNotes ?? []).toContain(
      "storage_limit",
    );
  });

  it("limits listed files and diff text per summary", async () => {
    const journal = new WorkHistoryJournal({
      maxFilesPerScope: 1,
      maxDiffBytesPerScope: 4,
    });
    journal.record(edit("a.ts", "1", "2"));
    journal.record(edit("b.ts", "1", "2"));
    const since = (await freeze(journal))!.sinceSummary;
    expect(since.files).toHaveLength(1);
    expect(since.omittedFiles).toBe(1);

    const tight = new WorkHistoryJournal({ maxDiffBytesPerScope: 2 });
    tight.record(edit("a.ts", "one", "two"));
    const [file] = (await freeze(tight))!.sinceSummary.files;
    expect(file!.segments[0]).toEqual({
      added: 1,
      removed: 1,
      omitted: "summary_budget",
    });
  });

  it("bounds tracked files and discontinuous segments, flagging the limit", async () => {
    const journal = new WorkHistoryJournal({
      maxTrackedFiles: 1,
      maxSegmentsPerFile: 2,
    });
    journal.record(edit("a.ts", "1", "2"));
    journal.record(edit("b.ts", "1", "2"));
    journal.record(edit("a.ts", "x", "y"));
    journal.record(edit("a.ts", "p", "q"));

    const since = (await freeze(journal))!.sinceSummary;
    expect(since.files.map((file) => file.path)).toEqual(["a.ts"]);
    expect(
      since.files[0]!.segments.map((segment) =>
        segment.hunks?.[0]?.lines.filter((line) => !line.startsWith("\\")),
      ),
    ).toEqual([
      ["-x", "+y"],
      ["-p", "+q"],
    ]);
    expect(since.coverageNotes).toContain("storage_limit");
  });

  it("stops tracking a file once its edits are reverted", async () => {
    const journal = new WorkHistoryJournal();
    journal.record(edit("a.ts", "1", "2"));
    await freeze(journal, "first");
    journal.record(edit("a.ts", "2", "1"));
    // The second interval shows the revert; the session scope has no net change.
    const second = await freeze(journal, "second");
    expect(second?.sinceSummary.files).toHaveLength(1);
    expect(second?.session).toBeUndefined();
    expect(journal.hasSessionChanges).toBe(false);
    expect(await freeze(journal, "third")).toBeUndefined();
  });

  it("flags a capture restart on the first summary and the session scope", async () => {
    const journal = new WorkHistoryJournal();
    journal.record(edit("a.ts", "1", "2"));
    const first = await journal.freeze({
      id: "1",
      capturedAt: 1,
      captureRestarted: true,
    });
    expect(first!.sinceSummary.coverageNotes).toContain("capture_restarted");

    journal.record(edit("b.ts", "1", "2"));
    const second = await journal.freeze({
      id: "2",
      capturedAt: 2,
      captureRestarted: true,
    });
    expect(second!.sinceSummary.coverageNotes).not.toContain(
      "capture_restarted",
    );
    expect(second!.session!.coverageNotes).toContain("capture_restarted");
  });
});
