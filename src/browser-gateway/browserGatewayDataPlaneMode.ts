export const BROWSER_GATEWAY_DATA_PLANE_MODES = [
  "off",
  "shadow",
  "on",
] as const;

export type BrowserGatewayDataPlaneMode =
  (typeof BROWSER_GATEWAY_DATA_PLANE_MODES)[number];

export const BROWSER_GATEWAY_DATA_PLANE_DEFAULT: BrowserGatewayDataPlaneMode =
  "on";

export function normalizeBrowserGatewayDataPlaneMode(
  value: unknown,
  fallback: BrowserGatewayDataPlaneMode,
): BrowserGatewayDataPlaneMode {
  return typeof value === "string" &&
    BROWSER_GATEWAY_DATA_PLANE_MODES.includes(
      value as BrowserGatewayDataPlaneMode,
    )
    ? (value as BrowserGatewayDataPlaneMode)
    : fallback;
}

export function resolveEffectiveBrowserGatewayDataPlaneMode(
  modes: readonly BrowserGatewayDataPlaneMode[],
): BrowserGatewayDataPlaneMode {
  if (modes.length === 0 || modes.includes("off")) return "off";
  if (modes.includes("shadow")) return "shadow";
  return "on";
}

export function isBrowserGatewayOwnerPublicationEnabled(
  mode: BrowserGatewayDataPlaneMode,
): boolean {
  return mode !== "off";
}
