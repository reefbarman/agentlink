import {
  BROWSER_GATEWAY_DATA_PLANE_DEFAULT,
  isBrowserGatewayOwnerPublicationEnabled,
  normalizeBrowserGatewayDataPlaneMode,
  resolveEffectiveBrowserGatewayDataPlaneMode,
  resolveRegisteredBrowserGatewayDataPlaneModes,
} from "./browserGatewayDataPlaneMode.js";
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

describe("browser gateway data-plane mode", () => {
  it("keeps the runtime and manifest dogfood defaults aligned", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes: {
        configuration: {
          properties: Record<string, { default?: unknown }>;
        };
      };
    };

    expect(BROWSER_GATEWAY_DATA_PLANE_DEFAULT).toBe("on");
    expect(
      manifest.contributes.configuration.properties[
        "agentlink.browserGateway.dataPlane"
      ].default,
    ).toBe(BROWSER_GATEWAY_DATA_PLANE_DEFAULT);
  });

  it("normalizes configured values with an explicit build fallback", () => {
    expect(normalizeBrowserGatewayDataPlaneMode("off", "shadow")).toBe("off");
    expect(normalizeBrowserGatewayDataPlaneMode("shadow", "off")).toBe(
      "shadow",
    );
    expect(normalizeBrowserGatewayDataPlaneMode("on", "off")).toBe("on");
    expect(normalizeBrowserGatewayDataPlaneMode("unknown", "shadow")).toBe(
      "shadow",
    );
  });

  it("uses the helper-authoritative multi-window precedence", () => {
    expect(resolveEffectiveBrowserGatewayDataPlaneMode([])).toBe("off");
    expect(resolveEffectiveBrowserGatewayDataPlaneMode(["shadow"])).toBe(
      "shadow",
    );
    expect(resolveEffectiveBrowserGatewayDataPlaneMode(["shadow", "on"])).toBe(
      "shadow",
    );
    expect(
      resolveEffectiveBrowserGatewayDataPlaneMode(["on", "shadow", "off"]),
    ).toBe("off");
  });

  it("fails stale or malformed registered modes safely to legacy off", () => {
    expect(
      resolveRegisteredBrowserGatewayDataPlaneModes(["on", undefined]),
    ).toEqual({
      mode: "off",
      missingCount: 1,
      invalidCount: 0,
    });
    expect(
      resolveRegisteredBrowserGatewayDataPlaneModes([
        "shadow",
        "future-mode",
        1,
      ]),
    ).toEqual({
      mode: "off",
      missingCount: 0,
      invalidCount: 2,
    });
    expect(resolveRegisteredBrowserGatewayDataPlaneModes(["on", "on"])).toEqual(
      {
        mode: "on",
        missingCount: 0,
        invalidCount: 0,
      },
    );
  });

  it("enables owner publication only outside off mode", () => {
    expect(isBrowserGatewayOwnerPublicationEnabled("off")).toBe(false);
    expect(isBrowserGatewayOwnerPublicationEnabled("shadow")).toBe(true);
    expect(isBrowserGatewayOwnerPublicationEnabled("on")).toBe(true);
  });
});
