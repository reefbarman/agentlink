export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000;
export const MIN_MCP_REQUEST_TIMEOUT_MS = 1;

export function resolveMcpRequestTimeout(timeout: unknown): number {
  if (
    typeof timeout !== "number" ||
    !Number.isFinite(timeout) ||
    timeout < MIN_MCP_REQUEST_TIMEOUT_MS
  ) {
    return DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  }
  return timeout;
}
