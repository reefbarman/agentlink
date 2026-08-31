import {
  BROWSER_GATEWAY_DATA_PLANE_DEFAULT,
  isBrowserGatewayOwnerPublicationEnabled,
  normalizeBrowserGatewayDataPlaneMode,
  resolveEffectiveBrowserGatewayDataPlaneMode,
  resolveRegisteredBrowserGatewayDataPlaneModes,
} from "./browserGatewayDataPlaneMode.js";
import { describe, expect, it } from "vitest";

describe("browser gateway data-plane mode", () => {
  it("keeps the browser-safe default enabled", () => {
    expect(BROWSER_GATEWAY_DATA_PLANE_DEFAULT).toBe("on");
  });

  it("normalizes configured values with an explicit fallback", () => {
    expect(normalizeBrowserGatewayDataPlaneMode("off", "shadow")).toBe("off");
    expect(normalizeBrowserGatewayDataPlaneMode("shadow", "off")).toBe(
      "shadow",
    );
    expect(normalizeBrowserGatewayDataPlaneMode("on", "off")).toBe("on");
    expect(normalizeBrowserGatewayDataPlaneMode("unknown", "shadow")).toBe(
      "shadow",
    );
  });

  it("uses helper-authoritative multi-window precedence", () => {
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

  it("fails stale or malformed registered modes safely to off", () => {
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
