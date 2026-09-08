import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNewSessionMode,
  getUserSessionPreference,
  rememberSessionMode,
} from "./sharedSessionPreferences.js";

import { getConfiguredBaseThresholdForModel } from "./modelCondenseThresholds.js";
import { resolveModelForMode } from "./modeModelPreferences.js";
import { resolveReasoningEffortForMode } from "./modeReasoningEffortPreferences.js";

const { globalValues, getConfiguration, update } = vi.hoisted(() => {
  const globalValues: Record<string, unknown> = {};
  const update = vi.fn(async (key: string, value: unknown) => {
    globalValues[key] = value;
  });
  return {
    globalValues,
    update,
    getConfiguration: vi.fn(() => ({
      inspect: (key: string) => ({
        globalValue: globalValues[key],
        workspaceFolderValue: "stale-workspace-value",
      }),
      get: () => "stale-workspace-value",
      update,
    })),
  };
});
vi.mock("vscode", () => ({
  workspace: { getConfiguration },
  ConfigurationTarget: { Global: 1 },
}));

describe("shared session defaults", () => {
  beforeEach(() => {
    for (const key of Object.keys(globalValues)) delete globalValues[key];
    vi.clearAllMocks();
  });

  it("reads the latest user defaults from separate window snapshots without workspace overrides", async () => {
    const windowA = getConfiguration();
    const windowB = getConfiguration();
    await rememberSessionMode("architect");
    await windowA.update("modeModelPreferences", { architect: "model-a" });
    await windowA.update("modeReasoningEffortPreferences", {
      architect: "max",
    });
    await windowA.update("modelCondenseThresholds", { "model-a": 0.73 });
    const config = windowB as never;
    expect(getNewSessionMode()).toBe("architect");
    expect(resolveModelForMode(config, "architect")).toBe("model-a");
    expect(resolveReasoningEffortForMode(config, "architect")).toBe("max");
    expect(getConfiguredBaseThresholdForModel(config, "model-a")).toBe(0.73);
    expect(update).toHaveBeenCalledWith("defaultMode", "architect", 1);
    await windowA.update("modeModelPreferences", { architect: "model-b" });
    expect(resolveModelForMode(config, "architect")).toBe("model-b");
  });

  it("merges a partial user model map over the declared mode defaults", () => {
    const config = {
      inspect: () => ({
        defaultValue: { code: "default-code", ask: "default-ask" },
        globalValue: { code: "chosen-code" },
        workspaceFolderValue: { ask: "stale-ask" },
      }),
    } as never;
    expect(resolveModelForMode(config, "code")).toBe("chosen-code");
    expect(resolveModelForMode(config, "ask")).toBe("default-ask");
  });

  it("uses declared defaults instead of legacy workspace values", () => {
    const config = {
      inspect: () => ({
        defaultValue: "code",
        workspaceValue: "debug",
        workspaceFolderValue: "ask",
      }),
    } as never;
    expect(getUserSessionPreference(config, "defaultMode")).toBe("code");
  });
});
