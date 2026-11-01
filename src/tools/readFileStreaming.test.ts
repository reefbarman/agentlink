import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  READ_FILE_STREAMED_LINE_MAX_CHARS,
  streamReadFileContentWindow,
} from "./readFileStreaming.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planReadFileContentWindow } from "@agentlink/core/read-file-content";

let dir: string;
const write = (name: string, text: string) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-read-stream-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("streamReadFileContentWindow", () => {
  // Several 1 MB stream chunks, CRLF lines, multi-byte text and a trailing
  // newline, so chunk boundaries split lines and characters.
  const lines = Array.from(
    { length: 60_000 },
    (_, i) => `${i % 7 === 0 ? "é" : ""}line ${i} ${"x".repeat(i % 50)}\r`,
  );
  const text = `${lines.join("\n")}\n`;

  it.each([
    {},
    { offset: 1, limit: 5 },
    { offset: 29_999, limit: 3 },
    { offset: 59_999, limit: 10 },
    { offset: 70_000 },
    { anchor: "line 41234 " },
    { anchor: "line 41234 ", anchor_offset: -3, limit: 7 },
    { anchor_regex: "^éline 700 ", limit: 2 },
    { anchor: "missing-needle", limit: 2 },
    { limit: 0 },
    { anchor_regex: "(" },
    { anchor: "a", anchor_regex: "b" },
  ])("matches the whole-file window for %j", async (params) => {
    const file = write("big.txt", text);
    expect(await streamReadFileContentWindow(file, params)).toEqual(
      planReadFileContentWindow(text, params),
    );
  });

  it("matches an empty file and a file without a trailing newline", async () => {
    for (const sample of ["", "only line", "a\nb"]) {
      const file = write("small.txt", sample);
      expect(await streamReadFileContentWindow(file, {})).toEqual(
        planReadFileContentWindow(sample, {}),
      );
    }
  });

  it("cuts very long lines and reports them", async () => {
    const long = "y".repeat(READ_FILE_STREAMED_LINE_MAX_CHARS + 500);
    const file = write("long.txt", `short\n${long}\nend`);
    const window = await streamReadFileContentWindow(file, {});
    expect(window).toMatchObject({
      status: "window",
      totalLines: 3,
      truncated: true,
      longLinesCut: 1,
    });
    expect(window.status === "window" && window.numbered).toBe(
      `1 | short\n2 | ${"y".repeat(READ_FILE_STREAMED_LINE_MAX_CHARS)}\n3 | end`,
    );
  });
});
