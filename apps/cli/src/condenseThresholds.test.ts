import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { SessionPreferencesStore } from "@agentlink/node-host";
import { createCliCondenseThresholds } from "./condenseThresholds.js";

describe("CLI condense thresholds", () => {
  it("saves, clamps and removes thresholds in the shared preferences file", async () => {
    const dataRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cli-thresholds-"),
    );
    try {
      const store = new SessionPreferencesStore({ dataRoot });
      const thresholds = createCliCondenseThresholds(store, undefined);
      await expect(thresholds.set("gpt-test", 0.75)).resolves.toBe(0.75);
      expect(thresholds.read()).toEqual({ "gpt-test": 0.75 });
      await expect(thresholds.set("gpt-test", 5)).resolves.toBe(1);
      await expect(store.read()).resolves.toMatchObject({
        modelCondenseThresholds: { "gpt-test": 1 },
      });
      await expect(thresholds.set("gpt-test", null)).resolves.toBeUndefined();
      expect(thresholds.read()).toEqual({});
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("picks up another writer's change after the refresh interval", async () => {
    let now = 0;
    const read = vi.fn(async () => ({
      modeModels: {},
      modeReasoningEfforts: {},
      modelCondenseThresholds: { "gpt-test": 0.5 },
    }));
    const thresholds = createCliCondenseThresholds(
      { read, update: vi.fn() },
      {
        modeModels: {},
        modeReasoningEfforts: {},
        modelCondenseThresholds: { "gpt-test": 0.8 },
      },
      () => now,
    );
    expect(thresholds.read()).toEqual({ "gpt-test": 0.8 });
    expect(read).not.toHaveBeenCalled();
    now = 6_000;
    thresholds.read();
    await vi.waitFor(() =>
      expect(thresholds.read()).toEqual({ "gpt-test": 0.5 }),
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("refresh shows another writer's change straight away", async () => {
    const read = vi.fn(async () => ({
      modeModels: {},
      modeReasoningEfforts: {},
      modelCondenseThresholds: { "gpt-test": 0.45 },
    }));
    const thresholds = createCliCondenseThresholds(
      { read, update: vi.fn() },
      {
        modeModels: {},
        modeReasoningEfforts: {},
        modelCondenseThresholds: { "gpt-test": 0.3 },
      },
      () => 0,
    );
    await expect(thresholds.refresh()).resolves.toEqual({ "gpt-test": 0.45 });
    expect(thresholds.read()).toEqual({ "gpt-test": 0.45 });
  });
});
