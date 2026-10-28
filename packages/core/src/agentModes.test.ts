import {
  BUILT_IN_MODES,
  getAllModes,
  mergeCustomModeSources,
  parseCustomModesJson,
  resolveMode,
} from "./agentModes.js";
import { describe, expect, it } from "vitest";

describe("agent modes", () => {
  it("parses JSONC custom modes with defaults and skips invalid entries", () => {
    const modes = parseCustomModesJson(`[
      // comment
      { "slug": "docs", "name": "Docs" },
      { "slug": "bad" },
      { "slug": "ops", "name": "Ops", "icon": "server", "toolGroups": ["read", "command"] },
    ]`);
    expect(modes).toEqual([
      expect.objectContaining({
        slug: "docs",
        icon: "symbol-misc",
        toolGroups: ["read", "search"],
      }),
      expect.objectContaining({
        slug: "ops",
        icon: "server",
        toolGroups: ["read", "command"],
      }),
    ]);
    expect(parseCustomModesJson("{not json")).toEqual([]);
    expect(parseCustomModesJson('{"slug":"x"}')).toEqual([]);
  });

  it("lets later sources override earlier ones and skips missing files", () => {
    const merged = mergeCustomModeSources([
      '[{"slug":"docs","name":"First"}]',
      undefined,
      '[{"slug":"docs","name":"Last"},{"slug":"ops","name":"Ops"}]',
    ]);
    expect(merged.map((mode) => [mode.slug, mode.name])).toEqual([
      ["docs", "Last"],
      ["ops", "Ops"],
    ]);
  });

  it("replaces built-ins by slug and falls back to code", () => {
    const all = getAllModes([
      { slug: "code", name: "Custom Code", icon: "code", toolGroups: ["read"] },
    ]);
    expect(all).toHaveLength(BUILT_IN_MODES.length);
    expect(resolveMode("code", all).name).toBe("Custom Code");
    expect(resolveMode("missing", all).name).toBe("Custom Code");
    expect(resolveMode("missing", []).slug).toBe("code");
  });
});
