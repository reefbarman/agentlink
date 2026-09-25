import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  McpAuthEvent,
  McpAuthorizationAttempt,
  McpAuthorizationDecision,
  McpHubOAuthProvider,
} from "@agentlink/node-host";

/** Adapts Desktop's isolated SDK provider to the shared hub lifecycle. */
export class StandaloneMcpHubOAuthProvider implements McpHubOAuthProvider {
  readonly signal: AbortSignal;
  onLog?: (message: string) => void;
  onBeforeAuthorizationOpen?: (
    request: Readonly<McpAuthorizationAttempt>,
  ) => McpAuthorizationDecision | Promise<McpAuthorizationDecision>;
  onTokensSaved?: (
    request: Readonly<McpAuthorizationAttempt>,
  ) => void | Promise<void>;
  readTokenGeneration?: (identity: string) => number | Promise<number>;
  onAuthEvent?: (event: McpAuthEvent) => void;
  authorizationAttempt?: Readonly<McpAuthorizationAttempt>;
  suppressRefreshTokenReauthPrompt = false;

  constructor(
    private readonly provider: OAuthClientProvider,
    private readonly serverUrl: string,
    private readonly fetch: typeof globalThis.fetch,
    private readonly hasActiveTurn: () => boolean,
    private readonly lifetime = new AbortController(),
  ) {
    this.signal = lifetime.signal;
  }

  get redirectUrl() {
    return this.provider.redirectUrl;
  }

  get clientMetadata() {
    return this.provider.clientMetadata;
  }

  get clientMetadataUrl() {
    return this.provider.clientMetadataUrl;
  }

  state() {
    return this.provider.state?.() ?? crypto.randomUUID();
  }

  clientInformation() {
    return this.provider.clientInformation();
  }

  saveClientInformation: NonNullable<
    OAuthClientProvider["saveClientInformation"]
  > = (value) => this.provider.saveClientInformation?.(value);

  tokens() {
    return this.provider.tokens();
  }

  async saveTokens(tokens: OAuthTokens) {
    await this.provider.saveTokens(tokens);
    if (this.authorizationAttempt) {
      await this.onTokensSaved?.(this.authorizationAttempt);
    }
  }

  saveCodeVerifier(value: string) {
    return this.provider.saveCodeVerifier(value);
  }

  codeVerifier() {
    return this.provider.codeVerifier();
  }

  saveDiscoveryState: OAuthClientProvider["saveDiscoveryState"] = (state) =>
    this.provider.saveDiscoveryState?.(state);

  discoveryState: OAuthClientProvider["discoveryState"] = () =>
    this.provider.discoveryState?.();

  async redirectToAuthorization(url: URL): Promise<void> {
    this.signal.throwIfAborted();
    if (!this.hasActiveTurn())
      throw new Error("standalone_mcp_oauth_no_active_turn");
    const attempt = this.authorizationAttempt;
    if (!attempt || attempt.authMode !== "interactive") {
      throw new Error("mcp_oauth_interactive_authorization_required");
    }
    const decision = await this.onBeforeAuthorizationOpen?.(attempt);
    if (!decision?.allowed)
      throw new Error("mcp_oauth_browser_authorization_denied");
    try {
      this.signal.throwIfAborted();
      await this.provider.redirectToAuthorization(url);
      // The Desktop SDK provider completes the code exchange internally, so its
      // saveTokens does not pass through this wrapper on the first login.
      if (await this.provider.tokens()) await this.onTokensSaved?.(attempt);
    } finally {
      await decision.lease.complete();
    }
  }

  async invalidateCredentials(
    kind: "all" | "client" | "tokens" | "verifier" | "discovery",
  ) {
    await this.provider.invalidateCredentials?.(kind);
  }

  async clearTokens() {
    await this.invalidateCredentials("tokens");
  }

  async forceReauth() {
    this.signal.throwIfAborted();
    await this.invalidateCredentials("all");
    await auth(this, {
      serverUrl: new URL(this.serverUrl),
      fetchFn: this.fetch,
    });
  }

  async start() {
    this.signal.throwIfAborted();
  }

  stop() {
    this.lifetime.abort();
  }

  async debugStateSnapshot(_label: string) {
    // Desktop does not persist a debug snapshot of OAuth credentials.
  }
}
