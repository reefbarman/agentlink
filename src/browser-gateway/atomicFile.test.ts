import { describe, expect, it, vi } from "vitest";

import type { AtomicFileOperations } from "./atomicFile.js";
import { writeTextFileAtomic } from "./atomicFile.js";

function makeFileOperations(
  overrides: Partial<AtomicFileOperations> = {},
): AtomicFileOperations {
  return {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("writeTextFileAtomic", () => {
  it("writes a same-directory unique temp file before replacing the target", async () => {
    const calls: string[] = [];
    const fileOperations = makeFileOperations({
      mkdir: vi.fn(async (dirPath) => {
        calls.push(`mkdir:${dirPath}`);
      }),
      writeFile: vi.fn(async (filePath, content, options) => {
        calls.push(`write:${filePath}:${content}:${options.mode}`);
      }),
      rename: vi.fn(async (oldPath, newPath) => {
        calls.push(`rename:${oldPath}:${newPath}`);
      }),
    });

    await writeTextFileAtomic("/state/preferences.json", "{}\n", {
      mode: 0o600,
      fileOperations,
      createTempId: () => "write-1",
    });

    const tempPath = `/state/preferences.json.tmp.${process.pid}.write-1`;
    expect(calls).toEqual([
      "mkdir:/state",
      `write:${tempPath}:{}\n:384`,
      `rename:${tempPath}:/state/preferences.json`,
    ]);
    expect(fileOperations.rm).not.toHaveBeenCalled();
  });

  it.each(["write", "rename"] as const)(
    "cleans up the temp file after a %s failure without hiding the error",
    async (failurePoint) => {
      const error = new Error(`${failurePoint} failed`);
      const fileOperations = makeFileOperations({
        writeFile: vi.fn(async () => {
          if (failurePoint === "write") throw error;
        }),
        rename: vi.fn(async () => {
          if (failurePoint === "rename") throw error;
        }),
      });

      await expect(
        writeTextFileAtomic("/state/history.json", "{}\n", {
          mode: 0o600,
          fileOperations,
          createTempId: () => "failed-write",
        }),
      ).rejects.toBe(error);

      expect(fileOperations.rm).toHaveBeenCalledWith(
        `/state/history.json.tmp.${process.pid}.failed-write`,
        { force: true },
      );
    },
  );

  it("uses distinct temp files for concurrent replacements", async () => {
    const tempPaths: string[] = [];
    const ids = ["first", "second"];
    const fileOperations = makeFileOperations({
      writeFile: vi.fn(async (filePath) => {
        tempPaths.push(filePath);
      }),
    });

    await Promise.all([
      writeTextFileAtomic("/state/shared.json", "one", {
        mode: 0o600,
        fileOperations,
        createTempId: () => ids.shift()!,
      }),
      writeTextFileAtomic("/state/shared.json", "two", {
        mode: 0o600,
        fileOperations,
        createTempId: () => ids.shift()!,
      }),
    ]);

    expect(new Set(tempPaths)).toEqual(
      new Set([
        `/state/shared.json.tmp.${process.pid}.first`,
        `/state/shared.json.tmp.${process.pid}.second`,
      ]),
    );
  });

  it("ignores cleanup failure and preserves the original write error", async () => {
    const error = new Error("write failed");
    const fileOperations = makeFileOperations({
      writeFile: vi.fn(async () => {
        throw error;
      }),
      rm: vi.fn(async () => {
        throw new Error("cleanup failed");
      }),
    });

    await expect(
      writeTextFileAtomic("/state/cache.json", "{}", {
        mode: 0o600,
        fileOperations,
        createTempId: () => "cleanup-failure",
      }),
    ).rejects.toBe(error);
  });
});
