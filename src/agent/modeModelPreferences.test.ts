import {
  FALLBACK_AGENT_MODEL,
  resolveModelForMode,
} from "./modeModelPreferences.js";
import { describe, expect, it } from "vitest";

import { CODEX_DEFAULT_MODEL } from "../core/model/providers/codex/models.js";

describe("mode model preferences", () => {
  it("uses the flagship Codex model when no preference is configured", () => {
    const config = {
      get: () => undefined,
    } as never;

    expect(FALLBACK_AGENT_MODEL).toBe(CODEX_DEFAULT_MODEL);
    expect(resolveModelForMode(config, "code")).toBe(CODEX_DEFAULT_MODEL);
  });

  it("preserves an explicitly configured mode preference", () => {
    const config = {
      get: (key: string) => {
        if (key === "modeModelPreferences") {
          return { code: "gpt-5.3-codex-spark" };
        }
        return undefined;
      },
    } as never;

    expect(resolveModelForMode(config, "code")).toBe("gpt-5.3-codex-spark");
  });
});
