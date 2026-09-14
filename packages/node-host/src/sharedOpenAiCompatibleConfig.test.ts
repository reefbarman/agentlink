import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  OPENAI_COMPATIBLE_CONFIG_FILENAME,
  SharedOpenAiCompatibleConfigStore,
} from "./sharedOpenAiCompatibleConfig.js";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

async function createStore(maxConfigBytes?: number) {
  const dataRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-openai-compatible-"),
  );
  roots.push(dataRoot);
  return {
    dataRoot,
    store: new SharedOpenAiCompatibleConfigStore({
      dataRoot,
      ...(maxConfigBytes === undefined ? {} : { maxConfigBytes }),
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("SharedOpenAiCompatibleConfigStore", () => {
  it("round-trips raw connections with a versioned document and restrictive permissions", async () => {
    const { dataRoot, store } = await createStore();
    const connections = [
      { id: "local", customFutureField: { retained: true } },
    ];

    await expect(store.read()).resolves.toBeUndefined();
    await store.write(connections);

    await expect(store.read()).resolves.toEqual({
      schemaVersion: 1,
      connections,
    });
    expect(store.configPath).toBe(
      path.join(dataRoot, OPENAI_COMPATIBLE_CONFIG_FILENAME),
    );
    expect((await fs.stat(dataRoot)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(store.configPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects a stale compare-before-write snapshot", async () => {
    const { store } = await createStore();
    await store.write([{ id: "first" }]);

    await expect(
      store.write([{ id: "replacement" }], {
        expectedConnections: [{ id: "stale" }],
      }),
    ).rejects.toThrow("agentlink_openai_compatible_config_changed");
    await expect(store.read()).resolves.toMatchObject({
      connections: [{ id: "first" }],
    });
  });

  it("imports legacy data only when shared config is absent and never mutates the source", async () => {
    const { store } = await createStore();
    const legacy = [{ id: "legacy" }];

    await expect(store.importLegacyIfAbsent(legacy)).resolves.toBe(true);
    expect(legacy).toEqual([{ id: "legacy" }]);
    await expect(
      store.importLegacyIfAbsent([{ id: "replacement" }]),
    ).resolves.toBe(false);
    await expect(store.read()).resolves.toEqual({
      schemaVersion: 1,
      connections: legacy,
    });
  });

  it.each([
    ["malformed", "{not-json"],
    ["forward version", JSON.stringify({ schemaVersion: 2, connections: [] })],
    [
      "invalid connections",
      JSON.stringify({ schemaVersion: 1, connections: {} }),
    ],
  ])("fails closed for %s config", async (_label, content) => {
    const { store } = await createStore();
    await fs.writeFile(store.configPath, content, { mode: 0o600 });

    await expect(store.read()).rejects.toThrow(
      "agentlink_openai_compatible_config_invalid",
    );
  });

  it("bounds reads before parsing", async () => {
    const { store } = await createStore(64);
    await fs.writeFile(store.configPath, "x".repeat(65), { mode: 0o600 });

    await expect(store.read()).rejects.toThrow(
      "agentlink_openai_compatible_config_invalid",
    );
  });
});
