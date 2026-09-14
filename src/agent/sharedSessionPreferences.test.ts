import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNewSessionMode,
  initializeSharedSessionPreferences,
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
