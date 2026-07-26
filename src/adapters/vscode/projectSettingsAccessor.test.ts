import {
  MACHINE_SCOPED_AGENTLINK_SETTINGS,
  PROJECT_SCOPED_AGENTLINK_SETTINGS,
  WINDOW_SCOPED_AGENTLINK_SETTINGS,
  createProjectSettingsAccessor,
} from "./projectSettingsAccessor.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readFileSync } from "fs";

const { get, getConfiguration, parse } = vi.hoisted(() => ({
  get: vi.fn(),
  getConfiguration: vi.fn(),
  parse: vi.fn((value: string) => ({ value })),
}));

vi.mock("vscode", () => ({
  Uri: { parse },
  workspace: { getConfiguration },
}));

describe("ProjectSettingsAccessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfiguration.mockReturnValue({ get });
    get.mockImplementation(
      (_key: string, defaultValue: unknown) => defaultValue,
    );
  });

  it("reads project settings with the selected workspace-folder URI", () => {
    get.mockReturnValue("project-model");
    const accessor = createProjectSettingsAccessor();

    expect(
      accessor.get(
        { workspaceFolderUri: "vscode-remote://host/workspace/api" },
        "modeModelPreferences",
        {},
      ),
    ).toBe("project-model");
    expect(parse).toHaveBeenCalledWith("vscode-remote://host/workspace/api");
    expect(getConfiguration).toHaveBeenCalledWith("agentlink", {
      value: "vscode-remote://host/workspace/api",
    });
    expect(
      accessor.getConfiguration({ uri: "file:///workspace/other" }),
    ).toEqual({ get });
    expect(getConfiguration).toHaveBeenLastCalledWith("agentlink", {
      value: "file:///workspace/other",
    });
    expect(get).toHaveBeenCalledWith("modeModelPreferences", {});
  });

  it("classifies every contributed setting exactly once with matching manifest scopes", () => {
    const classifications = [
      ...PROJECT_SCOPED_AGENTLINK_SETTINGS,
      ...MACHINE_SCOPED_AGENTLINK_SETTINGS,
      ...WINDOW_SCOPED_AGENTLINK_SETTINGS,
    ];
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes: {
        configuration: {
          properties: Record<string, { scope?: string }>;
        };
      };
    };
    const properties = manifest.contributes.configuration.properties;

    expect(classifications).toHaveLength(52);
    expect(MACHINE_SCOPED_AGENTLINK_SETTINGS).toContain(
      "terminal.environmentPolicy",
    );
    expect(MACHINE_SCOPED_AGENTLINK_SETTINGS).toContain(
      "openaiCompatible.connections",
    );
    expect(WINDOW_SCOPED_AGENTLINK_SETTINGS).toContain(
      "provider.maxConcurrentRequests",
    );
    expect(WINDOW_SCOPED_AGENTLINK_SETTINGS).toContain(
      "webAccess.searchBackend",
    );
    expect(WINDOW_SCOPED_AGENTLINK_SETTINGS).toContain(
      "webAccess.fetchBackend",
    );
    expect(WINDOW_SCOPED_AGENTLINK_SETTINGS).toContain(
      "webAccess.nativeSearchMode",
    );
    for (const removedSetting of [
      "webAccess.strategy",
      "webAccess.searchEnabled",
      "webAccess.fetchEnabled",
      "webAccess.mcpAdapter",
      "webAccess.mcpSearchTool",
      "webAccess.mcpFetchTool",
    ]) {
      expect(classifications).not.toContain(removedSetting);
      expect(properties).not.toHaveProperty(`agentlink.${removedSetting}`);
    }
    expect(new Set(classifications)).toHaveLength(classifications.length);
    expect(Object.keys(properties)).toHaveLength(classifications.length);
    for (const setting of PROJECT_SCOPED_AGENTLINK_SETTINGS) {
      expect(properties[`agentlink.${setting}`]?.scope).toBe("resource");
    }
    for (const setting of MACHINE_SCOPED_AGENTLINK_SETTINGS) {
      expect(properties[`agentlink.${setting}`]?.scope).toBe("machine");
    }
    for (const setting of WINDOW_SCOPED_AGENTLINK_SETTINGS) {
      expect(properties[`agentlink.${setting}`]?.scope).toBe("window");
    }
  });
});
