import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNewSessionMode,
  initializeSharedSessionPreferences,
  refreshSharedSessionPreferences,
  removeUserSessionPreferenceEntry,
  resetSharedSessionPreferencesForTesting,
  writeUserSessionPreferenceEntry,
} from "./sharedSessionPreferences.js";

import type { SessionPreferencesSnapshot } from "@agentlink/node-host";
import { getConfiguredBaseThresholdForModel } from "./modelCondenseThresholds.js";
import { resolveModelForMode } from "./modeModelPreferences.js";
import { resolveReasoningEffortForMode } from "./modeReasoningEffortPreferences.js";

function preferences(
  overrides: Partial<SessionPreferencesSnapshot> = {},
): SessionPreferencesSnapshot {
  return {
    modeModels: {},
    modeReasoningEfforts: {},
    modelCondenseThresholds: {},
    ...overrides,
  };
}

describe("shared session defaults", () => {
  beforeEach(() => resetSharedSessionPreferencesForTesting());

  it("uses the host-neutral snapshot for all picker defaults", () => {
    initializeSharedSessionPreferences(
      { update: vi.fn() } as never,
      preferences({
        defaultMode: "architect",
        modeModels: { architect: "model-a" },
        modeReasoningEfforts: { architect: "max" },
        modelCondenseThresholds: { "model-a": 0.73 },
      }),
    );
    const legacyConfig = {
      inspect: () => ({
        defaultValue: { architect: "default-model" },
        globalValue: { architect: "legacy-model" },
      }),
    } as never;

    expect(getNewSessionMode()).toBe("architect");
    expect(resolveModelForMode(legacyConfig, "architect")).toBe("model-a");
    expect(resolveReasoningEffortForMode(legacyConfig, "architect")).toBe(
      "max",
    );
    expect(getConfiguredBaseThresholdForModel(legacyConfig, "model-a")).toBe(
      0.73,
    );
  });

  it("writes picker changes to the shared store and refreshes the snapshot", async () => {
    const update = vi.fn(async () =>
      preferences({ modeModels: { code: "model-new" } }),
    );
    initializeSharedSessionPreferences(
      { update } as never,
      preferences({
        modeModels: { code: "model-old", ask: "cached-ask-model" },
      }),
    );
    const config = { inspect: () => undefined } as never;

    await writeUserSessionPreferenceEntry(
      config,
      "modeModelPreferences",
      "code",
      "model-new",
    );

    expect(update).toHaveBeenCalledWith({
      modeModels: { code: "model-new" },
    });
    expect(resolveModelForMode(config, "code")).toBe("model-new");
  });

  it("refreshes another window's saved per-mode models before a mode switch", async () => {
    const store = {
      read: vi.fn(async () =>
        preferences({
          modeModels: { code: "gpt-6-sol", architect: "gpt-6-astra" },
        }),
      ),
    };
    initializeSharedSessionPreferences(
      store as never,
      preferences({ modeModels: { code: "gpt-6-sol" } }),
    );
    const config = { inspect: () => undefined } as never;
    expect(resolveModelForMode(config, "architect", "gpt-6-sol")).toBe(
      "gpt-6-sol",
    );

    await refreshSharedSessionPreferences();

    expect(store.read).toHaveBeenCalledOnce();
    expect(resolveModelForMode(config, "architect", "gpt-6-sol")).toBe(
      "gpt-6-astra",
    );
  });

  it("does not replace a newer picker save with an older refresh", async () => {
    let finishRead!: (snapshot: SessionPreferencesSnapshot) => void;
    const store = {
      read: vi.fn(
        () =>
          new Promise<SessionPreferencesSnapshot>((resolve) => {
            finishRead = resolve;
          }),
      ),
      update: vi.fn(async () =>
        preferences({ modeModels: { code: "gpt-6-sol" } }),
      ),
    };
    initializeSharedSessionPreferences(
      store as never,
      preferences({ modeModels: { code: "old-model" } }),
    );
    const config = { inspect: () => undefined } as never;
    const refresh = refreshSharedSessionPreferences();
    await writeUserSessionPreferenceEntry(
      config,
      "modeModelPreferences",
      "code",
      "gpt-6-sol",
    );
    finishRead(preferences({ modeModels: { code: "old-model" } }));
    await refresh;

    expect(resolveModelForMode(config, "code")).toBe("gpt-6-sol");
  });

  it("removes picker overrides from shared and legacy storage", async () => {
    const update = vi.fn(async () => preferences());
    initializeSharedSessionPreferences(
      { update } as never,
      preferences({ modelCondenseThresholds: { "model-a": 0.73 } }),
    );
    const configUpdate = vi.fn(async () => undefined);
    const config = {
      inspect: () => ({
        globalValue: { "model-a": 0.73, "model-b": 0.8 },
      }),
      update: configUpdate,
    } as never;

    await removeUserSessionPreferenceEntry(
      config,
      "modelCondenseThresholds",
      "model-a",
    );

    expect(configUpdate).toHaveBeenCalledWith(
      "modelCondenseThresholds",
      { "model-b": 0.8 },
      true,
    );
    expect(update).toHaveBeenCalledWith({
      removeModelCondenseThresholds: ["model-a"],
    });
    expect(getConfiguredBaseThresholdForModel(config, "model-a")).toBe(0.9);
  });

  it("falls back to legacy User Settings before shared storage initializes", () => {
    const config = {
      inspect: () => ({
        defaultValue: { code: "default-code", ask: "default-ask" },
        globalValue: { code: "legacy-code" },
        workspaceFolderValue: { ask: "stale-ask" },
      }),
    } as never;

    expect(resolveModelForMode(config, "code")).toBe("legacy-code");
    expect(resolveModelForMode(config, "ask")).toBe("default-ask");
  });
});
