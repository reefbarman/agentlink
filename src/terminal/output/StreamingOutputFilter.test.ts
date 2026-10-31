import { describe, expect, it } from "vitest";

import {
  filterCommandOutput,
  type CommandOutputFilterOptions,
} from "@agentlink/core/command-output";

import {
  StreamingOutputFilter,
  applyStreamedOutputFilter,
  isStreamedOutputFilterSnapshot,
  sameStreamedOutputFilter,
  streamableOutputFilter,
} from "./StreamingOutputFilter.js";

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function streamThrough(
  output: string,
  filter: CommandOutputFilterOptions,
  random: () => number = Math.random,
) {
  const spec = streamableOutputFilter(filter);
  if (!spec) throw new Error("filter is not streamable");
  const streaming = new StreamingOutputFilter(spec);
  let index = 0;
  while (index < output.length) {
    const size = 1 + Math.floor(random() * 40);
    streaming.append(output.slice(index, index + size));
    index += size;
  }
  return streaming;
}

describe("streamableOutputFilter", () => {
  it("streams grep, head, and offset-only filters", () => {
    expect(streamableOutputFilter({ output_grep: "x" })).toEqual({
      output_grep: "x",
    });
    expect(
      streamableOutputFilter({
        output_grep: "x",
        output_grep_context: 2,
        output_head: 5,
        output_tail: 9,
        output_offset: 0,
      }),
    ).toEqual({ output_grep: "x", output_grep_context: 2, output_head: 5 });
    expect(streamableOutputFilter({ output_offset: 3 })).toEqual({
      output_offset: 3,
    });
  });

  it("leaves default, tail-only, and offset-plus-tail filters to the raw tail", () => {
    expect(streamableOutputFilter({})).toBeUndefined();
    expect(streamableOutputFilter({ output_tail: 10 })).toBeUndefined();
    expect(
      streamableOutputFilter({ output_tail: 10, output_offset: 2 }),
    ).toBeUndefined();
    expect(streamableOutputFilter(undefined)).toBeUndefined();
  });

  it("compares requested and streamed filters after normalization", () => {
    const streamed = streamableOutputFilter({
      output_grep: "err",
      output_head: 3,
    })!;
    expect(
      sameStreamedOutputFilter(
        { output_grep: "err", output_head: 3, output_offset: 0 },
        streamed,
      ),
    ).toBe(true);
    expect(
      sameStreamedOutputFilter(
        { output_grep: "err", output_head: 4 },
        streamed,
      ),
    ).toBe(false);
    expect(sameStreamedOutputFilter({ output_tail: 3 }, streamed)).toBe(false);
  });
});

describe("StreamingOutputFilter", () => {
  it("matches filterCommandOutput over the full stream for varied filters", () => {
    const random = seededRandom(42);
    const words = ["alpha", "beta", "ERROR", "warn", "gamma", "", "error x"];
    const filters: CommandOutputFilterOptions[] = [
      { output_grep: "error" },
      { output_grep: "error", output_head: 3 },
      { output_grep: "error", output_tail: 4 },
      { output_grep: "error", output_grep_context: 1 },
      { output_grep: "error", output_grep_context: 2, output_head: 7 },
      { output_grep: "error", output_grep_context: 1, output_tail: 5 },
      { output_grep: "error", output_offset: 2, output_head: 2 },
      { output_grep: "error", output_offset: 3, output_tail: 2 },
      { output_grep: "(?i)ERR" },
      { output_grep: "[unclosed" },
      { output_grep: "" },
      { output_head: 5 },
      { output_head: 0 },
      { output_head: 4, output_offset: 6 },
      { output_offset: 4 },
    ];
    for (let run = 0; run < 120; run++) {
      const lineCount = 1 + Math.floor(random() * 40);
      const lines = Array.from(
        { length: lineCount },
        () => words[Math.floor(random() * words.length)]!,
      );
      if (run % 7 === 0) lines.push("[unclosed bracket");
      const output = lines.join("\n") + (random() < 0.5 ? "\n" : "");
      if (output === "\n") continue;
      for (const filter of filters) {
        const expected = filterCommandOutput(output, filter);
        const streamed = applyStreamedOutputFilter(
          streamThrough(output, filter, random).snapshot(),
        );
        expect(
          {
            filtered: streamed?.filtered,
            totalLines: streamed?.totalLines,
            linesShown: streamed?.linesShown,
            truncated: streamed?.truncated,
          },
          `${JSON.stringify(filter)} over ${JSON.stringify(output)}`,
        ).toEqual(expected);
        expect(streamed?.exact).toBe(true);
      }
    }
  });

  it("keeps early grep matches after far more output than any raw tail", () => {
    const streaming = new StreamingOutputFilter(
      streamableOutputFilter({ output_grep: "^0x2148A4F", output_head: 400 })!,
    );
    streaming.append("0x2148A4F4C ldr x0, [x1]\n0x2148A4F50 ret\n");
    const filler = `${"0x0000 nop ".repeat(8)}\n`.repeat(4096);
    for (let index = 0; index < 64; index++) streaming.append(filler);

    const snapshot = streaming.snapshot();
    const retainedBytes = snapshot.lines.join("\n").length;
    expect(retainedBytes).toBeLessThan(1024);
    expect(snapshot.totalLines).toBe(2 + 64 * 4096);
    expect(applyStreamedOutputFilter(snapshot)).toMatchObject({
      filtered: "0x2148A4F4C ldr x0, [x1]\n0x2148A4F50 ret\n",
      linesShown: 2,
      truncated: false,
      exact: true,
    });
  });

  it("bounds retained candidates to the display limit", () => {
    const streaming = new StreamingOutputFilter({ output_grep: "match" });
    const line = `match ${"x".repeat(200)}\n`;
    for (let index = 0; index < 20_000; index++) streaming.append(line);

    const snapshot = streaming.snapshot();
    expect(snapshot.candidateLines).toBe(20_000);
    expect(snapshot.lines.join("\n").length).toBeLessThan(64 * 1024 + 400);
    const applied = applyStreamedOutputFilter(snapshot)!;
    expect(applied.truncated).toBe(true);
    expect(Buffer.byteLength(applied.filtered)).toBeLessThanOrEqual(64 * 1024);
  });

  it("keeps the newest matches for grep with tail", () => {
    const streaming = new StreamingOutputFilter(
      streamableOutputFilter({ output_grep: "hit", output_tail: 2 })!,
    );
    for (let index = 0; index < 10_000; index++) {
      streaming.append(index % 100 === 0 ? `hit ${index}\n` : `miss\n`);
    }
    const snapshot = streaming.snapshot();
    expect(snapshot.lines).toEqual(["hit 9800", "hit 9900"]);
    expect(applyStreamedOutputFilter(snapshot)?.filtered).toBe(
      "hit 9800\nhit 9900\n",
    );
  });

  it("cleans terminal controls and CRLF before matching", () => {
    const streaming = new StreamingOutputFilter({ output_grep: "^error:" });
    streaming.append("\u001b[31merror:\u001b[0m bad\r\nok\r\n");
    streaming.append("progress 10%\rerror: overwritten\r\n");
    expect(applyStreamedOutputFilter(streaming.snapshot())?.filtered).toBe(
      "error: bad\nerror: overwritten\n",
    );
  });

  it("redacts token assignments before matching and display", () => {
    const streaming = new StreamingOutputFilter({ output_grep: "TOKEN" });
    streaming.append("GITHUB_TOKEN=ghp_secret\nother\n");
    expect(applyStreamedOutputFilter(streaming.snapshot())?.filtered).toBe(
      "GITHUB_TOKEN=[REDACTED]\n",
    );
  });

  it("withholds all streamed lines once Kubernetes Secret output appears", () => {
    const streaming = new StreamingOutputFilter({ output_grep: "." });
    streaming.append("apiVersion: v1\ndata:\n  password: c2VjcmV0\n");
    streaming.append("kind: Secret\nmetadata:\n  name: db\n");

    const snapshot = streaming.snapshot();
    expect(snapshot.sensitive).toBe(true);
    expect(snapshot.lines).toEqual([]);
    expect(applyStreamedOutputFilter(snapshot)).toBeUndefined();
  });

  it("evaluates an unterminated final line without consuming it", () => {
    const streaming = new StreamingOutputFilter({ output_grep: "done" });
    streaming.append("working\ndo");
    expect(streaming.snapshot().lines).toEqual([]);
    streaming.append("ne");
    expect(streaming.snapshot().lines).toEqual(["done"]);
    streaming.append(" now\n");
    expect(streaming.snapshot()).toMatchObject({
      lines: ["done now"],
      totalLines: 2,
      endsWithNewline: true,
    });
  });

  it("bounds very long lines and reports them", () => {
    const streaming = new StreamingOutputFilter({ output_grep: "^start" });
    streaming.append(`start${"x".repeat(200_000)}\nnext\n`);
    const snapshot = streaming.snapshot();
    expect(snapshot.truncatedLines).toBe(1);
    expect(snapshot.exact).toBe(false);
    expect(snapshot.lines[0]!.length).toBe(64 * 1024);
    expect(snapshot.totalLines).toBe(2);
  });

  it("reports inexact context when before-context exceeds its byte bound", () => {
    const streaming = new StreamingOutputFilter({
      output_grep: "^hit$",
      output_grep_context: 5,
    });
    const wide = "y".repeat(40 * 1024);
    streaming.append(`${wide}\n${wide}\n${wide}\nhit\n`);
    expect(streaming.snapshot().exact).toBe(false);
  });

  it("produces snapshots that pass the runtime shape check", () => {
    const streaming = new StreamingOutputFilter({ output_head: 1 });
    streaming.append("a\nb\n");
    expect(isStreamedOutputFilterSnapshot(streaming.snapshot())).toBe(true);
    expect(isStreamedOutputFilterSnapshot({ lines: [] })).toBe(false);
    expect(isStreamedOutputFilterSnapshot(undefined)).toBe(false);
  });
});
