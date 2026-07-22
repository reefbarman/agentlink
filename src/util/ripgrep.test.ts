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
