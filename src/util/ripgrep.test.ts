import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const { accessMock, execFileMock, spawnMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  access: accessMock,
}));

vi.mock("child_process", async () => {
  const actual =
    await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execFile: execFileMock,
    spawn: spawnMock,
  };
});

vi.mock("vscode", () => ({
  env: { appRoot: "/mock/vscode" },
}));

describe("getRipgrepBinPath", () => {
  beforeEach(() => {
    vi.resetModules();
    accessMock.mockReset();
    execFileMock.mockReset();
  });

  it("finds VS Code's platform-specific ripgrep-universal binary", async () => {
    const binName = process.platform.startsWith("win") ? "rg.exe" : "rg";
    const expected = path.join(
      "/mock/vscode",
      "node_modules.asar.unpacked/@vscode/ripgrep-universal/bin",
      `${process.platform}-${process.arch}`,
      binName,
    );
    accessMock.mockImplementation(async (candidate: string) => {
      if (candidate === expected) return;
      throw new Error("ENOENT");
    });

    const { getRipgrepBinPath } = await import("./ripgrep.js");

    await expect(getRipgrepBinPath()).resolves.toBe(expected);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("falls back to a verified ripgrep binary on PATH", async () => {
    const binName = process.platform.startsWith("win") ? "rg.exe" : "rg";
    accessMock.mockRejectedValue(new Error("ENOENT"));
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, "ripgrep 15.1.0\n"),
    );

    const { getRipgrepBinPath } = await import("./ripgrep.js");

    await expect(getRipgrepBinPath()).resolves.toBe(binName);
    expect(execFileMock).toHaveBeenCalledWith(
      binName,
      ["--version"],
      expect.objectContaining({ timeout: 2_000, windowsHide: true }),
      expect.any(Function),
    );
  });

  it("reports both discovery locations when no usable binary exists", async () => {
    accessMock.mockRejectedValue(new Error("ENOENT"));
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(new Error("ENOENT"), ""),
    );

    const { getRipgrepBinPath } = await import("./ripgrep.js");

    await expect(getRipgrepBinPath()).rejects.toThrow(
      "Could not find a usable ripgrep binary in the VS Code installation or on PATH",
    );
  });
});

describe("execRipgrepFiles", () => {
  function child() {
    const process = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    spawnMock.mockReturnValue(process);
    return process;
  }

  it.each([{ files: [] }, { files: ["./src/example.ts"] }])(
    "preserves listing results $files when a broken symlink is skipped",
    async ({ files }) => {
      const process = child();
      const { execRipgrepFiles } = await import("./ripgrep.js");
      const result = execRipgrepFiles("rg", ["--files", "--follow"], 500);
      for (const file of files) process.stdout.write(`${file}\n`);
      const warning =
        "rg: ./.claude/skills/typesafe-ai: No such file or directory (os error 2)";
      process.stderr.write(`${warning}\n`);
      process.emit("close", 2);
      await expect(result).resolves.toEqual({
        files,
        warnings: [warning],
        exitCode: 2,
        truncated: false,
      });
    },
  );

  it("keeps invalid arguments fatal even when there are traversal warnings", async () => {
    const process = child();
    const { execRipgrepFiles } = await import("./ripgrep.js");
    const result = execRipgrepFiles("rg", ["--invalid"], 500);
    process.stderr.write(
      "rg: ./broken: No such file or directory\nerror: unrecognized flag --invalid\n",
    );
    process.emit("close", 2);
    await expect(result).rejects.toThrow("unrecognized flag");
  });

  it("does not turn a process launch failure into an empty listing", async () => {
    const process = child();
    const { execRipgrepFiles } = await import("./ripgrep.js");
    const result = execRipgrepFiles("missing-rg", [], 500);
    process.emit("error", new Error("spawn ENOENT"));
    await expect(result).rejects.toThrow("ripgrep process error");
  });
});

describe("parseRipgrepOutput", () => {
  it("preserves captured matches when a capped stream omits the final end event", async () => {
    const { parseRipgrepOutput } = await import("./ripgrep.js");
    const output = [
      JSON.stringify({
        type: "begin",
        data: { path: { text: "/workspace/src/example.ts" } },
      }),
      JSON.stringify({
        type: "match",
        data: {
          path: { text: "/workspace/src/example.ts" },
          lines: { text: "const needle = true;\n" },
          line_number: 7,
          absolute_offset: 42,
        },
      }),
    ].join("\n");

    expect(parseRipgrepOutput(output, "/workspace")).toEqual({
      totalMatches: 1,
      results: [
        {
          file: "/workspace/src/example.ts",
          searchResults: [
            {
              lines: [
                {
                  line: 7,
                  text: "const needle = true;\n",
                  isMatch: true,
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("flushes a matched file when a capped stream starts another file", async () => {
    const { parseRipgrepOutput } = await import("./ripgrep.js");
    const output = [
      JSON.stringify({
        type: "begin",
        data: { path: { text: "/workspace/src/first.ts" } },
      }),
      JSON.stringify({
        type: "match",
        data: {
          path: { text: "/workspace/src/first.ts" },
          lines: { text: "needle\n" },
          line_number: 1,
          absolute_offset: 0,
        },
      }),
      JSON.stringify({
        type: "begin",
        data: { path: { text: "/workspace/src/second.ts" } },
      }),
    ].join("\n");

    expect(parseRipgrepOutput(output, "/workspace")).toMatchObject({
      totalMatches: 1,
      results: [{ file: "/workspace/src/first.ts" }],
    });
  });
});
