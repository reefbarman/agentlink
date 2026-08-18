import { describe, expect, it } from "vitest";
import {
  expandAgentPluginEnvironment,
  expandAgentPluginPlaceholders,
  expandAgentPluginStringArray,
} from "./placeholderExpansion.js";

const replacements = {
  pluginRoot: "/plugins/example/${PLUGIN_DATA}",
  pluginData: "/data/example",
};

describe("Agent Plugin placeholder expansion", () => {
  it("replaces every adjacent exact occurrence in one non-recursive pass", () => {
    expect(
      expandAgentPluginPlaceholders(
        "${PLUGIN_ROOT}${PLUGIN_DATA}:${PLUGIN_ROOT}",
        replacements,
      ),
    ).toBe(
      "/plugins/example/${PLUGIN_DATA}/data/example:/plugins/example/${PLUGIN_DATA}",
    );
  });

  it("leaves unknown and environment-style expressions literal", () => {
    expect(
      expandAgentPluginPlaceholders(
        "${UNKNOWN}:$HOME:${HOME}:$PLUGIN_ROOT",
        replacements,
      ),
    ).toBe("${UNKNOWN}:$HOME:${HOME}:$PLUGIN_ROOT");
  });

  it("expands arrays and environment values without changing keys", () => {
    expect(
      expandAgentPluginStringArray(
        ["${PLUGIN_ROOT}/script", "${PLUGIN_DATA}/state"],
        replacements,
      ),
    ).toEqual([
      "/plugins/example/${PLUGIN_DATA}/script",
      "/data/example/state",
    ]);
    expect(
      expandAgentPluginEnvironment(
        { "${PLUGIN_ROOT}": "${PLUGIN_DATA}/state" },
        replacements,
      ),
    ).toEqual({ "${PLUGIN_ROOT}": "/data/example/state" });
  });
});
