export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000;
export const MIN_MCP_REQUEST_TIMEOUT_MS = 1;
export const MAX_MCP_REQUEST_TIMEOUT_MS = 299_000;

export function resolveMcpRequestTimeout(timeout: unknown): number {
  if (
    typeof timeout !== "number" ||
    !Number.isFinite(timeout) ||
    timeout <= 0
  ) {
    return DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  }
  return Math.min(timeout, MAX_MCP_REQUEST_TIMEOUT_MS);
}
