/**
 * Host-assigned identity of a session within the VS Code chat workspace.
 *
 * The tab number comes from the chat tab layout, never from the model. Tab
 * display numbers are reused after a tab closes, so the short session id is
 * included to tell a later tab with the same number apart.
 */
export interface SessionIdentity {
  /** Display number of the chat tab that owns the session (or its root). */
  readonly tabNumber: number;
  /** True for background agents started from that tab. */
  readonly background: boolean;
}

const SHORT_SESSION_ID_LENGTH = 8;

export function shortSessionId(sessionId: string): string {
  return sessionId.replace(/-/g, "").slice(0, SHORT_SESSION_ID_LENGTH);
}

export function sessionIdentitiesEqual(
  a: SessionIdentity | undefined,
  b: SessionIdentity | undefined,
): boolean {
  return a?.tabNumber === b?.tabNumber && a?.background === b?.background;
}

/**
 * Short host-assigned label for MCP session context: `tab-2` for a chat tab,
 * `tab-2/bg-1a2b3c4d` for a background agent started from it.
 */
export function buildSessionLabel(
  sessionId: string,
  identity: SessionIdentity,
): string {
  const tab = `tab-${identity.tabNumber}`;
  return identity.background ? `${tab}/bg-${shortSessionId(sessionId)}` : tab;
}

/**
 * One static section appended after the cached system prompt. It changes only
 * when the owning tab changes, so it does not disturb prompt caching.
 */
export function buildSessionIdentitySection(
  sessionId: string,
  identity: SessionIdentity,
): string {
  const id = `\`${shortSessionId(sessionId)}\``;
  const line = identity.background
    ? `You are a background agent (session ${id}) started from AgentLink chat tab ${identity.tabNumber}.`
    : `You are AgentLink chat tab ${identity.tabNumber} (session ${id}).`;
  return `## Session Identity\n\n${line}`;
}
