import { auth as sdkAuth } from "@modelcontextprotocol/client";
import type { auth as EsmAuth } from "@modelcontextprotocol/client" with {
  "resolution-mode": "import",
};

/**
 * The helper compiles as CommonJS and sees the MCP SDK's `.d.cts`
 * declarations, while node-host OAuth providers carry the `.d.mts` ones. The
 * two declaration sets are structurally incompatible (private class fields),
 * so expose the same runtime `auth` with the ESM-side signature that matches
 * the providers this helper passes to it.
 */
export const auth = sdkAuth as unknown as typeof EsmAuth;
