/** Native Desktop follows VS Code's HTTP(S) MCP networking, including private hosts. */
export function isSupportedStandaloneMcpOAuthDestination(url: URL): boolean {
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    !url.username &&
    !url.password
  );
}
