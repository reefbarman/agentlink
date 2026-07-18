export const WEB_ACCESS_DISCLOSURE_VERSION = 1;
export const WEB_ACCESS_DISCLOSURE_STATE_KEY =
  "agentlink.webAccessDisclosureVersion";
export const WEB_ACCESS_SETTINGS_ACTION = "Review Web Access Settings";

export const WEB_ACCESS_DISCLOSURE_MESSAGE =
  "AgentLink now exposes native web_search and web_fetch tools by default when the selected provider supports them. The model decides when to use them. Native provider requests may add provider charges and send queries or fetched content to the selected provider. Choosing MCP hides the corresponding native tool while ordinary connected MCP tools remain available under their own names and policies. Web content is untrusted model input. Set agentlink.webAccess.searchBackend and agentlink.webAccess.fetchBackend to Disabled before a turn to prohibit native web access.";

export interface WebAccessDisclosureState {
  get(key: string, defaultValue: number): number;
  update(key: string, value: unknown): Thenable<void>;
}

export interface WebAccessDisclosureDependencies {
  state: WebAccessDisclosureState;
  showInformationMessage(
    message: string,
    action: typeof WEB_ACCESS_SETTINGS_ACTION,
  ): Thenable<string | undefined>;
  openSettings(query: string): Thenable<unknown>;
}

export async function showWebAccessDisclosureOnce(
  dependencies: WebAccessDisclosureDependencies,
): Promise<boolean> {
  const shownVersion = dependencies.state.get(
    WEB_ACCESS_DISCLOSURE_STATE_KEY,
    0,
  );
  if (shownVersion >= WEB_ACCESS_DISCLOSURE_VERSION) return false;

  // Mark the revision before opening UI so overlapping activation attempts cannot
  // show duplicate notices. A transient notification failure is intentionally not
  // retried on every activation; a future disclosure change increments the version.
  await dependencies.state.update(
    WEB_ACCESS_DISCLOSURE_STATE_KEY,
    WEB_ACCESS_DISCLOSURE_VERSION,
  );
  const action = await dependencies.showInformationMessage(
    WEB_ACCESS_DISCLOSURE_MESSAGE,
    WEB_ACCESS_SETTINGS_ACTION,
  );
  if (action === WEB_ACCESS_SETTINGS_ACTION) {
    await dependencies.openSettings("agentlink.webAccess");
  }
  return true;
}
