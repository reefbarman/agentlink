import * as fs from "fs";

import {
  InlineCommandFileError,
  materializeInlineCommandFiles,
  quotePosixShellArg,
  validateInlineCommandFiles,
} from "./commandInlineFiles.js";
import { describe, expect, it } from "vitest";

function expectInlineError(fn: () => unknown, code: string): void {
  expect(fn).toThrow(InlineCommandFileError);
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(InlineCommandFileError);
    expect((err as InlineCommandFileError).code).toBe(code);
  }
}

describe("commandInlineFiles", () => {
  it("materializes files, substitutes quoted paths, and cleans up", () => {
    const run = materializeInlineCommandFiles(
      "gh pr comment 12 --body-file $AL_FILE(body)",
      [{ name: "body", content: "hello `code` can't fail", ext: "md" }],
    );

    expect(run).toBeDefined();
    if (!run) throw new Error("expected inline run");
    expect(run.commandTemplate).toBe(
      "gh pr comment 12 --body-file $AL_FILE(body)",
    );
    expect(run.command).toMatch(
      /^gh pr comment 12 --body-file '\/.*\/body\.md'$/,
    );
    expect(run.previews).toMatchObject([
      {
        name: "body",
        ext: "md",
        bytes: Buffer.byteLength("hello `code` can't fail", "utf-8"),
        truncated: false,
        executable: false,
        preview: "hello `code` can't fail",
      },
    ]);
    expect(run.previews[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(run.previews[0].path)).toBe(true);

    const dir = run.previews[0].path.replace(/\/body\.md$/, "");
    run.cleanup();
    expect(fs.existsSync(dir)).toBe(false);
    run.cleanup();
  });

  it("supports multiple and repeated references", () => {
    const run = materializeInlineCommandFiles(
      "cmd $AL_FILE(a) $AL_FILE(b) $AL_FILE(a)",
      [
        { name: "a", content: "a" },
        { name: "b", content: "b" },
      ],
    );
    expect(run?.command).toContain("/a'");
    expect(run?.command).toContain("/b'");
    run?.cleanup();
  });

  it("returns undefined for missing or empty files", () => {
    expect(materializeInlineCommandFiles("echo ok", undefined)).toBeUndefined();
    expect(materializeInlineCommandFiles("echo ok", [])).toBeUndefined();
  });

  it("rejects unknown references", () => {
    expectInlineError(
      () =>
        validateInlineCommandFiles("cat $AL_FILE(missing)", [
          { name: "body", content: "x" },
        ]),
      "unknown_reference",
    );
  });

  it("rejects unreferenced files", () => {
    expectInlineError(
      () =>
        validateInlineCommandFiles("echo ok", [{ name: "body", content: "x" }]),
      "unreferenced_file",
    );
  });

  it("rejects duplicate names", () => {
    expectInlineError(
      () =>
        validateInlineCommandFiles("cat $AL_FILE(body)", [
          { name: "body", content: "x" },
          { name: "body", content: "y" },
        ]),
      "duplicate_name",
    );
  });

  it("rejects path-like names and extensions", () => {
    expectInlineError(
      () =>
        validateInlineCommandFiles("cat $AL_FILE(..)", [
          { name: "..", content: "x" },
        ]),
      "invalid_name",
    );
    expectInlineError(
      () =>
        validateInlineCommandFiles("cat $AL_FILE(body)", [
          { name: "body", ext: "../md", content: "x" },
        ]),
      "invalid_ext",
    );
  });

  it("rejects invalid token-like strings", () => {
    expectInlineError(
      () =>
        validateInlineCommandFiles("cat $AL_FILE(body/path)", [
          { name: "body", content: "x" },
        ]),
      "unreferenced_file",
    );
  });

  it("enforces the total byte cap", () => {
    expectInlineError(
      () =>
        validateInlineCommandFiles("cat $AL_FILE(body)", [
          { name: "body", content: "x".repeat(2 * 1024 * 1024 + 1) },
        ]),
      "size_limit_exceeded",
    );
  });

  it("truncates non-executable previews but not executable previews", () => {
    const long = Array.from({ length: 45 }, (_, i) => `line ${i}`).join("\n");
    const run = materializeInlineCommandFiles(
      "sh $AL_FILE(script) && cat $AL_FILE(body)",
      [
        { name: "script", content: long, mode: "755", ext: "sh" },
        { name: "body", content: long, ext: "md" },
      ],
    );
    expect(
      run?.previews.find((file) => file.name === "script")?.truncated,
    ).toBe(false);
    expect(run?.previews.find((file) => file.name === "script")?.preview).toBe(
      long,
    );
    expect(run?.previews.find((file) => file.name === "body")?.truncated).toBe(
      true,
    );
    expect(
      run?.previews.find((file) => file.name === "body")?.preview.split("\n"),
    ).toHaveLength(40);
    run?.cleanup();
  });

  it("quotes POSIX shell arguments", () => {
    expect(quotePosixShellArg("/tmp/with space/it's.md")).toBe(
      "'/tmp/with space/it'\\''s.md'",
    );
  });
});
