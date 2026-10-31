import * as fs from "node:fs";

import {
  STILL_RUNNING_OUTPUT_WARNING,
  STREAMED_OUTPUT_FILTER_FIELD,
  presentCommandOutput,
  readStreamedOutputFilter,
} from "./commandOutput.js";
import {
  StreamingOutputFilter,
  streamableOutputFilter,
} from "./output/StreamingOutputFilter.js";
import { afterEach, describe, expect, it } from "vitest";

const savedFiles: string[] = [];

afterEach(() => {
  for (const file of savedFiles.splice(0)) {
    fs.rmSync(file, { force: true });
  }
});

function present(input: Parameters<typeof presentCommandOutput>[0]) {
  const result = presentCommandOutput(input);
  if (result.output_file) savedFiles.push(result.output_file);
  return result;
}

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join("\n") +
  "\n";

describe("presentCommandOutput", () => {
  it("notes intentional caller filtering without a truncation warning", () => {
    const result = present({
      output: lines(31),
      complete: true,
      finalized: true,
      filter: { output_tail: 16 },
    });

    expect(result).toMatchObject({
      total_lines: 31,
      lines_shown: 16,
      output_truncated: false,
      total_lines_scope: "complete",
      output_file: expect.any(String),
    });
    expect(result.output_warning).toBeUndefined();
    expect(result.output_note).toBe(
      "Showing 16 of 31 lines selected by your output filter; no output was lost. The complete output is in output_file if you need lines outside the filter.",
    );
    expect(fs.readFileSync(result.output_file!, "utf8")).toBe(lines(31));
  });

  it("treats grep and head reductions as intentional filtering", () => {
    for (const filter of [
      { output_grep: "line 1" },
      { output_head: 2 },
      { output_offset: 5 },
    ]) {
      const result = present({
        output: lines(30),
        complete: true,
        finalized: true,
        filter,
      });
      expect(result.output_note, JSON.stringify(filter)).toContain(
        "no output was lost",
      );
      expect(result.output_warning).toBeUndefined();
    }
  });

  it("keeps the strong warning for the default preview cap", () => {
    const result = present({
      output: lines(250),
      complete: true,
      finalized: true,
      filter: {},
    });

    expect(result.lines_shown).toBe(200);
    expect(result.output_file).toEqual(expect.any(String));
    expect(result.output_warning).toContain("Output was truncated");
    expect(result.output_warning).toContain("Do NOT re-run");
    expect(result.output_note).toBeUndefined();
  });

  it("keeps the strong warning when the byte bound truncates a filtered display", () => {
    const result = present({
      output: `${"x".repeat(70 * 1024)}\n`,
      complete: true,
      finalized: true,
      filter: { output_head: 1 },
    });

    expect(result.output_truncated).toBe(true);
    expect(result.output_warning).toContain("Output was truncated");
    expect(result.output_note).toBeUndefined();
  });

  it("adds no note or file when the filter shows everything", () => {
    const result = present({
      output: lines(3),
      complete: true,
      finalized: true,
      filter: { output_tail: 10 },
    });

    expect(result.output_file).toBeUndefined();
    expect(result.output_warning).toBeUndefined();
    expect(result.output_note).toBeUndefined();
  });

  it("warns while output is still running", () => {
    const result = present({
      output: lines(3),
      complete: false,
      finalized: false,
      droppedBytes: 0,
      filter: { output_tail: 1 },
    });

    expect(result.total_lines_scope).toBe("retained");
    expect(result.output_warning).toBe(STILL_RUNNING_OUTPUT_WARNING);
    expect(result.output_file).toBeUndefined();
  });

  describe("after raw-output loss", () => {
    const filter = { output_grep: "^match", output_head: 2 };

    function streamedFor(output: string, requested = filter) {
      const streaming = new StreamingOutputFilter(
        streamableOutputFilter(requested)!,
      );
      streaming.append(output);
      return streaming.snapshot();
    }

    it("presents streamed matches and reports the raw loss", () => {
      const streamed = streamedFor(`match 1\nmatch 2\n${lines(50, "noise")}`);
      const result = present({
        output: lines(5, "noise"),
        complete: false,
        finalized: true,
        droppedBytes: 2048,
        filter,
        streamed,
      });

      expect(result).toMatchObject({
        output: "match 1\nmatch 2\n",
        total_lines: 52,
        lines_shown: 2,
        output_truncated: false,
        total_lines_scope: "complete",
        output_filter_source: "streamed",
      });
      expect(result.output_file).toBeUndefined();
      expect(result.output_warning).toContain(
        "2.0 KiB of raw output was not retained",
      );
      expect(result.output_warning).toContain("complete output stream");
    });

    it("presents live streamed matches for a running command", () => {
      const result = present({
        output: lines(5, "noise"),
        complete: false,
        finalized: false,
        droppedBytes: 10,
        filter,
        streamed: streamedFor("match 1\nnoise\n"),
      });

      expect(result).toMatchObject({
        output: "match 1\n",
        total_lines_scope: "observed",
        output_filter_source: "streamed",
      });
      expect(result.output_warning).toContain("still running");
    });

    it("falls back to the retained tail for a different filter", () => {
      const result = present({
        output: lines(5, "noise"),
        complete: false,
        finalized: true,
        droppedBytes: 2048,
        filter: { output_grep: "noise" },
        streamed: streamedFor("match 1\n"),
      });

      expect(result.output_filter_source).toBeUndefined();
      expect(result.output_warning).toContain("bounded capture limit");
      expect(result.output_warning).toContain("repeat that exact filter");
    });

    it("never presents sensitive streamed output", () => {
      const result = present({
        output: lines(5, "noise"),
        complete: false,
        finalized: true,
        droppedBytes: 2048,
        filter,
        streamed: streamedFor("match 1\nkind: Secret\n"),
      });

      expect(result.output_filter_source).toBeUndefined();
      expect(result.output).not.toContain("match 1");
      expect(result.output_warning).not.toContain("repeat that exact filter");
    });

    it("ignores streamed matches when no raw output was lost", () => {
      const result = present({
        output: "match 9\n",
        complete: true,
        finalized: true,
        droppedBytes: 0,
        filter,
        streamed: streamedFor("match 1\n"),
      });

      expect(result.output).toBe("match 9\n");
      expect(result.output_filter_source).toBeUndefined();
    });
  });
});

describe("readStreamedOutputFilter", () => {
  it("reads only well-formed snapshots from retained output", () => {
    const streaming = new StreamingOutputFilter({ output_head: 1 });
    streaming.append("a\n");
    const snapshot = streaming.snapshot();

    expect(
      readStreamedOutputFilter({ [STREAMED_OUTPUT_FILTER_FIELD]: snapshot }),
    ).toEqual(snapshot);
    expect(
      readStreamedOutputFilter({
        [STREAMED_OUTPUT_FILTER_FIELD]: { lines: 1 },
      }),
    ).toBeUndefined();
    expect(readStreamedOutputFilter({ output: "a" })).toBeUndefined();
    expect(readStreamedOutputFilter(undefined)).toBeUndefined();
  });
});
