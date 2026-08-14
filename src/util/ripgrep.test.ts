import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { accessMock, execFileMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  execFileMock: vi.fn(),
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
