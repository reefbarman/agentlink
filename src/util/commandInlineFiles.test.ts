import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  InlineCommandFileError,
  materializeInlineCommandFiles,
  quotePosixShellArg,
  validateInlineCommandFiles,
} from "./commandInlineFiles.js";
import { describe, expect, it } from "vitest";

import { execFileSync } from "node:child_process";

const posixShell = process.env.SHELL ?? "/bin/sh";

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

  it.each([
    ["unquoted", "cat $AL_FILE(body)"],
    ["single-quoted", "cat '$AL_FILE(body)'"],
    ["double-quoted", 'cat "$AL_FILE(body)"'],
    ["embedded assignment", 'INPUT="$AL_FILE(body)"; cat "$AL_FILE(body)"'],
  ])("substitutes an exact path in %s context", (_label, command) => {
    const run = materializeInlineCommandFiles(command, [
      { name: "body", content: "exact content" },
    ]);
    expect(run).toBeDefined();
    if (!run) throw new Error("expected inline run");

    try {
      expect(
        execFileSync(posixShell, ["-c", run.command], { encoding: "utf8" }),
      ).toBe("exact content");
      expect(run.command).not.toContain("$AL_FILE(");
    } finally {
      run.cleanup();
    }
  });

  it("supports multiple and repeated references", () => {
    const run = materializeInlineCommandFiles(
      "cmd $AL_FILE(a) '$AL_FILE(b)' \"$AL_FILE(a)\"",
      [
        { name: "a", content: "a" },
        { name: "b", content: "b" },
      ],
    );
    expect(run?.command).toContain("/a'");
    expect(run?.command).toContain("/b'");
    run?.cleanup();
  });

  it("does not duplicate an extension already present in the name", () => {
    const run = materializeInlineCommandFiles(
      "cat $AL_FILE(NOTES.MD) $AL_FILE(archive.md)",
      [
        { name: "NOTES.MD", content: "notes", ext: "md" },
        { name: "archive.md", content: "archive", ext: "txt" },
      ],
    );

    expect(run?.command).toMatch(/\/NOTES\.MD'/);
    expect(run?.command).not.toContain("NOTES.MD.md");
    expect(run?.previews[0]).toMatchObject({
      name: "NOTES.MD",
      ext: undefined,
    });
    expect(run?.command).toMatch(/\/archive\.md\.txt'/);
    expect(run?.previews[1]).toMatchObject({ name: "archive.md", ext: "txt" });
    run?.cleanup();
  });

  it("rejects files that resolve to the same temp filename", () => {
    expectInlineError(
      () =>
        validateInlineCommandFiles("cat $AL_FILE(notes) $AL_FILE(notes.md)", [
          { name: "notes", content: "one", ext: "md" },
          { name: "notes.md", content: "two", ext: "md" },
        ]),
      "duplicate_filename",
    );
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

  it("rejects invalid token-like strings even after a valid token", () => {
    expectInlineError(
      () =>
        validateInlineCommandFiles("cat $AL_FILE(body) $AL_FILE(body/path)", [
          { name: "body", content: "x" },
        ]),
      "unresolved_token",
    );
  });

  it.each([
    ["escaped token", String.raw`cat \$AL_FILE(body)`],
    ["comment token", "echo ok # $AL_FILE(body)"],
    ["heredoc", "cat <<EOF\n$AL_FILE(body)\nEOF"],
    ["ANSI-C quote", "printf $'$AL_FILE(body)'"],
    ["command substitution", "echo $(cat $AL_FILE(body))"],
    ["backtick substitution", "echo `cat $AL_FILE(body)`"],
    ["parameter expansion", "echo ${value:-$AL_FILE(body)}"],
    ["plain parameter expansion", "echo $value $AL_FILE(body)"],
    ["arithmetic expansion", "echo $((1 + $AL_FILE(body)))"],
    ["legacy arithmetic expansion", "echo $[1 + 1] $AL_FILE(body)"],
    ["process substitution", "diff <(cat $AL_FILE(body)) expected"],
    ["zsh process substitution", "cat =(printf ok) $AL_FILE(body)"],
    ["here string", "cat <<< $AL_FILE(body)"],
    ["unterminated quote", "cat '$AL_FILE(body)"],
    ["dangling escape", "cat $AL_FILE(body) " + "\\"],
  ])("rejects unsupported %s context", (_label, command) => {
    expectInlineError(
      () =>
        validateInlineCommandFiles(command, [{ name: "body", content: "x" }]),
      "unsupported_context",
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

  it("materializes through an adversarial temp root without expansion or side effects", () => {
    const originalTmpdir = process.env.TMPDIR;
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-inline-adversarial-"),
    );
    const adversarialRoot = path.join(
      root,
      "space ' double\" dollar$AL_FILE(fragment) backtick` slash\\ line\nroot",
    );
    const sentinel = path.join(root, "sentinel");
    fs.mkdirSync(adversarialRoot);
    process.env.TMPDIR = adversarialRoot;

    try {
      for (const command of [
        "cat $AL_FILE(body)",
        "cat '$AL_FILE(body)'",
        'cat "$AL_FILE(body)"',
      ]) {
        const run = materializeInlineCommandFiles(command, [
          { name: "body", content: "adversarial content" },
        ]);
        expect(run).toBeDefined();
        if (!run) throw new Error("expected inline run");
        try {
          const output = execFileSync(
            posixShell,
            ["-c", `${run.command}; test ! -e ${quotePosixShellArg(sentinel)}`],
            { encoding: "utf8" },
          );
          expect(output).toBe("adversarial content");
        } finally {
          run.cleanup();
        }
      }
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("quotes POSIX shell arguments", () => {
    expect(quotePosixShellArg("/tmp/with space/it's.md")).toBe(
      "'/tmp/with space/it'\\''s.md'",
    );
  });
});
