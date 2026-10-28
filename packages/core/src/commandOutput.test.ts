import { describe, expect, it } from "vitest";
import { filterCommandOutput, redactCommandOutput } from "./commandOutput.js";

describe("command output filter", () => {
  it("greps, offsets and limits lines as VS Code does", () => {
    const output = "a\nERR one\nb\nERR two\nERR three\n";
    expect(
      filterCommandOutput(output, { output_grep: "err", output_offset: 1 }),
    ).toEqual({
      filtered: "ERR two\nERR three\n",
      totalLines: 5,
      linesShown: 2,
      truncated: false,
    });
    expect(filterCommandOutput(output, { output_head: 2 }).filtered).toBe(
      "a\nERR one\n",
    );
    expect(
      filterCommandOutput("x\nhit\ny\ngap\nz\nhit\n", {
        output_grep: "hit",
        output_grep_context: 1,
      }).filtered,
    ).toBe("x\nhit\ny\n--\nz\nhit\n");
  });

  it("keeps the last 200 lines by default and redacts secrets", () => {
    const many = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
    const result = filterCommandOutput(many, {});
    expect(result.linesShown).toBe(200);
    expect(result.filtered.startsWith("line 50\n")).toBe(true);
    expect(redactCommandOutput("API_KEY=abc123\n")).toBe(
      "API_KEY=[REDACTED]\n",
    );
  });
});
