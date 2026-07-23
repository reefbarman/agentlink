import {
  normalizeBrowserGatewayDataPlaneMode,
  type BrowserGatewayDataPlaneMode,
} from "../../browserGatewayDataPlaneMode";

export const RELAY_SHADOW_OVERRIDE_STORAGE_KEY =
  "agentlink.browserGateway.relayClient.v1";

export function resolveRelayClientEnabled(options: {
  dataPlaneMode: BrowserGatewayDataPlaneMode | string | undefined;
  developmentBuild: boolean;
  search?: string;
  storedOverride?: string | null;
}): boolean {
  const mode = normalizeBrowserGatewayDataPlaneMode(
    options.dataPlaneMode,
    "off",
  );
  if (mode === "off") return false;
  if (mode === "on") return true;
  if (!options.developmentBuild) return false;
  const searchOverride = new URLSearchParams(options.search ?? "").get(
    "dataPlane",
  );
  return (
    searchOverride === "relay" ||
    searchOverride === "1" ||
    options.storedOverride === "relay" ||
    options.storedOverride === "1"
  );
}
