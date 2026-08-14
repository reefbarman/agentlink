export const BROWSER_GATEWAY_ASK_AGENT_OWNER_ID = "browser-gateway:ask-agent";
export const BROWSER_GATEWAY_ASK_AGENT_SESSION_ID_PREFIX =
  "browser-gateway:ask-agent:";
export const BROWSER_GATEWAY_ASK_AGENT_SESSION_ID =
  "browser-gateway:ask-agent:default";

/**
 * Ask Agent session ids may be minted by the browser client (so a new chat can
 * be targeted before the helper round-trip completes, and re-created by the
 * first send if the helper restarted in between). Only ids of this shape are
 * accepted from clients.
 */
export function isBrowserGatewayAskAgentSessionId(value: string): boolean {
  if (!value.startsWith(BROWSER_GATEWAY_ASK_AGENT_SESSION_ID_PREFIX)) {
    return false;
  }
  const suffix = value.slice(
    BROWSER_GATEWAY_ASK_AGENT_SESSION_ID_PREFIX.length,
  );
  return /^[A-Za-z0-9-]{1,64}$/.test(suffix);
}
export const BROWSER_GATEWAY_ASK_AGENT_OWNER_GENERATION_ID =
  "browser-gateway:ask-agent:default-generation";
export const BROWSER_GATEWAY_ASK_AGENT_SCOPE_ID = "default-ask-agent";
