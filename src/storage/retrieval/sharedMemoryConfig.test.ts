import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import type { SharedMemoryConfigFileOperations } from "./sharedMemoryConfig.js";
import { SharedMemoryConfigStore } from "./sharedMemoryConfig.js";

const tempDirs: string[] = [];

async function makeConfigPath(): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-shared-memory-config-"),
  );
  tempDirs.push(dir);
  return path.join(dir, "nested", "memory-config.json");
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("SharedMemoryConfigStore", () => {
  it("defaults to autonomous when the config file is absent", async () => {
    const store = new SharedMemoryConfigStore(await makeConfigPath());

    await expect(store.read()).resolves.toEqual({ mode: "autonomous" });
  });

  it("reads a valid mode from disk", async () => {
    const configPath = await makeConfigPath();
    const store = new SharedMemoryConfigStore(configPath);
    await store.write("off");

    await expect(store.read()).resolves.toEqual({ mode: "off" });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(
      `${JSON.stringify({ mode: "off" }, null, 2)}\n`,
    );
  });

  it.each([
    ["malformed JSON", "{not-json"],
    ["missing mode", JSON.stringify({})],
    ["unknown mode", JSON.stringify({ mode: "always" })],
    ["non-object payload", JSON.stringify("autonomous")],
  ])("fails closed on %s instead of defaulting", async (_name, content) => {
    const configPath = await makeConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, content, "utf-8");
    const store = new SharedMemoryConfigStore(configPath);

    await expect(store.read()).resolves.toEqual({
      mode: "off",
      reason: "config_invalid",
    });
  });

  it("fails closed when the file exists but cannot be read", async () => {
    const configPath = await makeConfigPath();
    const store = new SharedMemoryConfigStore(configPath, {
      fileOperations: {
        stat: async () => ({ mtimeMs: 1, size: 10 }),
        readFile: async () => {
          throw Object.assign(new Error("permission denied"), {
            code: "EACCES",
          });
        },
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        rename: async () => undefined,
        rm: async () => undefined,
      },
    });

    await expect(store.read()).resolves.toEqual({
      mode: "off",
      reason: "config_unreadable",
    });
  });

  it("serves unchanged files from the mtime cache and rereads on change", async () => {
    const configPath = await makeConfigPath();
    let readCount = 0;
    let content = JSON.stringify({ mode: "autonomous" });
    let mtimeMs = 100;
    const fileOperations: SharedMemoryConfigFileOperations = {
      stat: async () => ({ mtimeMs, size: content.length }),
      readFile: async () => {
        readCount += 1;
        return content;
      },
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      rename: async () => undefined,
      rm: async () => undefined,
    };
    const store = new SharedMemoryConfigStore(configPath, { fileOperations });

    await expect(store.read()).resolves.toEqual({ mode: "autonomous" });
    await expect(store.read()).resolves.toEqual({ mode: "autonomous" });
    expect(readCount).toBe(1);

    content = JSON.stringify({ mode: "off" });
    mtimeMs = 200;
    await expect(store.read()).resolves.toEqual({ mode: "off" });
    expect(readCount).toBe(2);
  });

  it("does not cache invalid content", async () => {
    const configPath = await makeConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "{broken", "utf-8");
    const store = new SharedMemoryConfigStore(configPath);

    await expect(store.read()).resolves.toMatchObject({
      reason: "config_invalid",
    });
    await fs.writeFile(
      configPath,
      JSON.stringify({ mode: "autonomous" }),
      "utf-8",
    );
    await expect(store.read()).resolves.toEqual({ mode: "autonomous" });
  });

  it("invalidates the cache after its own writes", async () => {
    const configPath = await makeConfigPath();
    const store = new SharedMemoryConfigStore(configPath);

    await store.write("autonomous");
    await expect(store.read()).resolves.toEqual({ mode: "autonomous" });
    await store.write("off");
    await expect(store.read()).resolves.toEqual({ mode: "off" });
  });

  it("seeds only when the config file is absent", async () => {
    const configPath = await makeConfigPath();
    const store = new SharedMemoryConfigStore(configPath);

    await expect(store.seed("off")).resolves.toBe(true);
    await expect(store.read()).resolves.toEqual({ mode: "off" });

    await expect(store.seed("autonomous")).resolves.toBe(false);
    await expect(store.read()).resolves.toEqual({ mode: "off" });
  });

  it("cleans up the temp file when an atomic write fails", async () => {
    const configPath = await makeConfigPath();
    const removed: string[] = [];
    const store = new SharedMemoryConfigStore(configPath, {
      createTempId: () => "temp-id",
      fileOperations: {
        stat: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        readFile: async () => "",
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        rename: async () => {
          throw new Error("rename failed");
        },
        rm: async (filePath) => {
          removed.push(filePath);
        },
      },
    });

    await expect(store.write("off")).rejects.toThrow("rename failed");
    expect(removed).toEqual([`${configPath}.tmp.${process.pid}.temp-id`]);
  });

  it("serializes overlapping writes", async () => {
    const configPath = await makeConfigPath();
    const order: string[] = [];
    const store = new SharedMemoryConfigStore(configPath, {
      fileOperations: {
        stat: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        readFile: async () => "",
        mkdir: async () => undefined,
        writeFile: async (_filePath, content) => {
          order.push(`start:${content.includes("off") ? "off" : "autonomous"}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(`end:${content.includes("off") ? "off" : "autonomous"}`);
        },
        rename: async () => undefined,
        rm: async () => undefined,
      },
    });

    await Promise.all([store.write("off"), store.write("autonomous")]);
    expect(order).toEqual([
      "start:off",
      "end:off",
      "start:autonomous",
      "end:autonomous",
    ]);
  });
});
