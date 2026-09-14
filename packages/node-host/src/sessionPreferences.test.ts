import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  SESSION_PREFERENCES_FILENAME,
  SessionPreferencesStore,
} from "./sessionPreferences.js";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

async function makeStore() {
  const dataRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-session-preferences-"),
  );
  roots.push(dataRoot);
  return { dataRoot, store: new SessionPreferencesStore({ dataRoot }) };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("SessionPreferencesStore", () => {
  it("reads an absent store as empty preferences", async () => {
    const { store } = await makeStore();

    await expect(store.read()).resolves.toEqual({
      modeModels: {},
      modeReasoningEfforts: {},
      modelCondenseThresholds: {},
    });
  });

  it("uses AGENTLINK_HOME as the default shared root", async () => {
    const dataRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-session-preferences-env-"),
    );
    roots.push(dataRoot);

    const store = new SessionPreferencesStore({
      environment: { AGENTLINK_HOME: dataRoot },
    });

    expect(store.dataRoot).toBe(dataRoot);
    await store.update({ modeModels: { code: "model-from-env" } });
    await expect(
      fs.readFile(path.join(dataRoot, SESSION_PREFERENCES_FILENAME), "utf8"),
    ).resolves.toContain("model-from-env");
  });

  it("merges concurrent per-mode updates under a cross-process lock", async () => {
    const { dataRoot, store } = await makeStore();
    const second = new SessionPreferencesStore({ dataRoot });

    await Promise.all([
      store.update({
        defaultMode: "code",
        modeModels: { code: "gpt-5.6-sol" },
      }),
      second.update({
        modeModels: { ask: "gpt-6-astra" },
        modeReasoningEfforts: { ask: "high" },
      }),
      store.update({ modelCondenseThresholds: { "gpt-6-astra": 0.7 } }),
    ]);

    await expect(store.read()).resolves.toEqual({
      defaultMode: "code",
      modeModels: { ask: "gpt-6-astra", code: "gpt-5.6-sol" },
      modeReasoningEfforts: { ask: "high" },
      modelCondenseThresholds: { "gpt-6-astra": 0.7 },
    });
    const stat = await fs.stat(
      path.join(dataRoot, SESSION_PREFERENCES_FILENAME),
    );
    if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
  });

  it("imports only legacy values missing from an existing shared file", async () => {
    const { store } = await makeStore();
    await store.update({
      defaultMode: "ask",
      modeModels: { code: "shared-code" },
      modeReasoningEfforts: { code: "high" },
    });

    await expect(
      store.importLegacyIfAbsent({
        defaultMode: "debug",
        modeModels: { code: "legacy-code", ask: "legacy-ask" },
        modeReasoningEfforts: { code: "low", ask: "medium" },
        modelCondenseThresholds: { "legacy-ask": 0.72 },
      }),
    ).resolves.toEqual({
      defaultMode: "ask",
      modeModels: { ask: "legacy-ask", code: "shared-code" },
      modeReasoningEfforts: { ask: "medium", code: "high" },
      modelCondenseThresholds: { "legacy-ask": 0.72 },
    });
  });

  it("sanitizes map entries and rejects malformed documents", async () => {
    const { dataRoot, store } = await makeStore();
    const configPath = path.join(dataRoot, SESSION_PREFERENCES_FILENAME);
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        schemaVersion: 1,
        defaultMode: " code ",
        modeModels: { " ask ": " model-a ", empty: " " },
        modeReasoningEfforts: { code: "high", ask: "invalid" },
        modelCondenseThresholds: { " model-a ": 0.7, invalid: 2 },
      })}\n`,
    );

    await expect(store.read()).resolves.toEqual({
      defaultMode: "code",
      modeModels: { ask: "model-a" },
      modeReasoningEfforts: { code: "high" },
      modelCondenseThresholds: { "model-a": 0.7 },
    });

    await fs.writeFile(configPath, '{"schemaVersion":2}\n');
    await expect(store.read()).rejects.toThrow(
      "agentlink_session_preferences_invalid",
    );
  });
});
