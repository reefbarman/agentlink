import * as crypto from "crypto";
import * as http from "http";
import * as net from "net";
import * as vscode from "vscode";

import type {
  McpAuthorizationAttempt,
  McpAuthorizationDecision,
} from "./mcpAuthCoordinator.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { McpAuthEvent } from "../telemetry/McpAuthTelemetry.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { renderMcpOAuthCallbackPage } from "../shared/mcpOAuthCallbackPage.js";

export { renderMcpOAuthCallbackPage } from "../shared/mcpOAuthCallbackPage.js";

export class McpOAuthError extends Error {
  constructor(
    public readonly kind:
      | "callback_timeout"
      | "callback_missing_code"
      | "authorization_error"
      | "stale_client_redirect"
      | "credentials_updated",
    message: string,
  ) {
    super(message);
    this.name = "McpOAuthError";
  }
}

type StorageSuffix = "client" | "tokens";

/**
 * OAuth credentials are keyed by server identity (name + URL hash) so they
 * survive hub reloads/generations and are shared by every hub in this window
 * (main, Ask Agent, per-project). Earlier releases namespaced these keys per
 * hub instance — including a per-reload generation counter — which orphaned
 * refresh tokens on every MCP config reload and forced interactive reauth.
 */
function serverUrlHash(serverUrl: string): string {
  return crypto
    .createHash("sha256")
    .update(serverUrl)
    .digest("hex")
    .slice(0, 12);
}

function storageKey(
  serverName: string,
  serverUrl: string,
  suffix: StorageSuffix,
): string {
  return `mcp_oauth_${serverName}_${serverUrlHash(serverUrl)}_${suffix}`;
}

/**
 * Storage keys used by earlier releases, in migration-preference order:
 * the un-namespaced main-hub layout, then the "ask-agent" namespace.
 * Generation-scoped project keys are unrecoverable (the counter was
 * in-memory) and are removed by {@link cleanupOrphanedMcpOAuthState}.
 */
function legacyStorageKeys(
  serverName: string,
  suffix: StorageSuffix,
): string[] {
  return [
    `mcp_oauth_${serverName}_${suffix}`,
    `mcp_oauth_ask-agent_${serverName}_${suffix}`,
  ];
}

const ORPHANED_PROJECT_KEY_PREFIX = "mcp_oauth_project-";

/** Remove credentials orphaned under generation-scoped project namespaces. */
export async function cleanupOrphanedMcpOAuthState(
  storage: vscode.Memento,
): Promise<void> {
  // Some Memento test doubles omit keys(); cleanup is best-effort.
  if (typeof storage.keys !== "function") return;
  for (const key of storage.keys()) {
    if (key.startsWith(ORPHANED_PROJECT_KEY_PREFIX)) {
      await storage.update(key, undefined);
    }
  }
}

/**
 * OAuthClientProvider implementation for MCP HTTP servers.
 *
 * Flow:
 * 1. `start()` binds a local HTTP server for the redirect URI, preferring the
 *    previously registered localhost callback port when available and falling back
 *    to an OS-assigned ephemeral port otherwise.
 * 2. When the MCP transport gets a 401, the SDK calls `auth()` which in turn calls
 *    `redirectToAuthorization()`.  Our async implementation opens a browser and
 *    awaits the OAuth callback before returning, so by the time it resolves the
 *    tokens are already saved and the SDK can retry the connection.
 */
interface OAuthCallbackResult {
  url: URL;
  oauthError?: string;
  oauthErrorDescription?: string;
  hasCode: boolean;
}

export class McpOAuthProvider implements OAuthClientProvider {
  private _port = 0;
  private _server: http.Server | null = null;
  private _codeVerifier = "";
  onLog?: (message: string) => void;
  onBeforeAuthorizationOpen?: (
    request: Readonly<McpAuthorizationAttempt>,
  ) => McpAuthorizationDecision | Promise<McpAuthorizationDecision>;
  onTokensSaved?: (
    request: Readonly<McpAuthorizationAttempt>,
  ) => void | Promise<void>;
  readTokenGeneration?: (
    serverIdentityHash: string,
  ) => number | Promise<number>;
  onAuthEvent?: (event: McpAuthEvent) => void;
  authorizationAttempt?: Readonly<McpAuthorizationAttempt>;
  suppressRefreshTokenReauthPrompt = false;
  private preauthorizedDecision?: Extract<
    McpAuthorizationDecision,
    { allowed: true }
  >;

  private authEventBase(attempt: Readonly<McpAuthorizationAttempt>) {
    return {
      serverName: attempt.serverName,
      serverIdentityHash: attempt.serverIdentityHash,
      trigger: attempt.trigger,
      authMode: attempt.authMode,
      userInitiated: attempt.userInitiated,
      attemptId: attempt.attemptId,
      rootAttemptId: attempt.rootAttemptId,
      parentAttemptId: attempt.parentAttemptId,
      hubScope: attempt.hubScope,
      hubGeneration: attempt.hubGeneration,
      retryCount: attempt.retryCount,
      tokenGenerationBefore: attempt.tokenGenerationBefore,
    } as const;
  }

  private tokenSummary(tokens: OAuthTokens | undefined): string {
    if (!tokens) return "none";
    return JSON.stringify({
      hasAccessToken: Boolean(tokens.access_token),
      hasRefreshToken: Boolean(tokens.refresh_token),
      tokenType: tokens.token_type ?? null,
      expiresIn: tokens.expires_in ?? null,
      scope: tokens.scope ?? null,
    });
  }

  private clientSummary(info: OAuthClientInformationMixed | undefined): string {
    if (!info) return "none";
    return JSON.stringify({
      clientId:
        "client_id" in info && typeof info.client_id === "string"
          ? info.client_id
          : null,
      hasClientSecret: "client_secret" in info && Boolean(info.client_secret),
      redirectUris:
        "redirect_uris" in info && Array.isArray(info.redirect_uris)
          ? info.redirect_uris
          : null,
    });
  }

  async debugStateSnapshot(label: string): Promise<void> {
    const [clientInfo, tokens] = await Promise.all([
      this.readStored<OAuthClientInformationMixed>("client"),
      this.readStored<OAuthTokens>("tokens"),
    ]);
    this.onLog?.(
      `[mcp:${this.serverName}] oauth state ${label} redirectUrl=${this.redirectUrl} codeVerifierSet=${Boolean(this._codeVerifier)} client=${this.clientSummary(clientInfo)} tokens=${this.tokenSummary(tokens)}`,
    );
  }

  constructor(
    private readonly serverName: string,
    private readonly serverUrl: string,
    private readonly storage: vscode.Memento,
  ) {}

  private key(suffix: StorageSuffix): string {
    return storageKey(this.serverName, this.serverUrl, suffix);
  }

  /**
   * Read a stored credential, migrating (moving) any legacy-keyed value to
   * the server-identity key on first access.
   */
  private async readStored<T>(suffix: StorageSuffix): Promise<T | undefined> {
    const current = this.storage.get<T>(this.key(suffix));
    if (current !== undefined) return current;
    for (const legacyKey of legacyStorageKeys(this.serverName, suffix)) {
      const legacy = this.storage.get<T>(legacyKey);
      if (legacy !== undefined) {
        await this.storage.update(this.key(suffix), legacy);
        await this.storage.update(legacyKey, undefined);
        this.onLog?.(
          `[mcp:${this.serverName}] migrated legacy oauth ${suffix} storage to server-identity key`,
        );
        return legacy;
      }
    }
    return undefined;
  }

  /** Delete a credential everywhere so a wipe cannot resurrect via migration. */
  private async deleteStored(suffix: StorageSuffix): Promise<void> {
    await this.storage.update(this.key(suffix), undefined);
    for (const legacyKey of legacyStorageKeys(this.serverName, suffix)) {
      await this.storage.update(legacyKey, undefined);
    }
  }

  private preferredCallbackPort(
    info: OAuthClientInformationMixed | undefined,
  ): number | undefined {
    const redirectUris = this.redirectUrisForClient(info);
    if (!redirectUris) return undefined;

    for (const redirectUri of redirectUris) {
      try {
        const parsed = new URL(redirectUri);
        if (parsed.protocol !== "http:") continue;
        if (
          parsed.hostname !== "localhost" &&
          parsed.hostname !== "127.0.0.1" &&
          parsed.hostname !== "::1"
        ) {
          continue;
        }

        const port = Number(parsed.port);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
        return port;
      } catch {
        // ignore malformed cached URIs
      }
    }

    return undefined;
  }

  private async listenOnPort(port: number): Promise<void> {
    if (!this._server) return;

    await new Promise<void>((resolve, reject) => {
      const server = this._server!;
      const onError = (err: Error): void => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off("error", onError);
        this._port = (server.address() as net.AddressInfo).port;
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "localhost");
    });
  }

  /** Start the local callback HTTP server and capture the assigned port. */
  async start(): Promise<void> {
    if (this._server) return;

    const clientInfo =
      await this.readStored<OAuthClientInformationMixed>("client");
    const preferredPort = this.preferredCallbackPort(clientInfo);

    this._server = http.createServer();

    try {
      if (preferredPort) {
        try {
          await this.listenOnPort(preferredPort);
          this.onLog?.(
            `[mcp:${this.serverName}] callback server bound to preferred cached redirect port ${preferredPort}`,
          );
          return;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          this.onLog?.(
            `[mcp:${this.serverName}] preferred cached redirect port ${preferredPort} unavailable (${code ?? "unknown"}); falling back to ephemeral callback port`,
          );
        }
      }

      await this.listenOnPort(0);
      this.onLog?.(
        `[mcp:${this.serverName}] callback server bound to port ${this._port}${preferredPort ? ` (fallback from preferred ${preferredPort})` : ""}`,
      );
    } catch (err) {
      this._server?.close();
      this._server = null;
      this._port = 0;
      throw err;
    }
  }

  /** Stop the callback server. */
  stop(): void {
    this._server?.close();
    this._server = null;
    this._port = 0;
  }

  // ── OAuthClientProvider interface ──────────────────────────────────────

  get redirectUrl(): string {
    return `http://localhost:${this._port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "AgentLink",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  private redirectUrisForClient(
    info: OAuthClientInformationMixed | undefined,
  ): string[] | undefined {
    return info && "redirect_uris" in info && Array.isArray(info.redirect_uris)
      ? info.redirect_uris
      : undefined;
  }

  private hasRedirectUriMismatch(
    info: OAuthClientInformationMixed | undefined,
  ): boolean {
    const redirectUris = this.redirectUrisForClient(info);
    return Boolean(redirectUris && !redirectUris.includes(this.redirectUrl));
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const info = await this.readStored<OAuthClientInformationMixed>("client");

    const redirectUris = this.redirectUrisForClient(info);
    if (redirectUris && !redirectUris.includes(this.redirectUrl)) {
      this.onLog?.(
        `[mcp:${this.serverName}] cached client redirect URIs do not include current redirectUrl; keeping cached client to allow refresh-token flow first current=${this.redirectUrl} cached=${JSON.stringify(redirectUris)}`,
      );
    }

    return info;
  }

  async saveClientInformation(
    info: OAuthClientInformationMixed,
  ): Promise<void> {
    this.onLog?.(
      `[mcp:${this.serverName}] saveClientInformation() ${this.clientSummary(info)}`,
    );
    await this.storage.update(this.key("client"), info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.readStored<OAuthTokens>("tokens");
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.onLog?.(
      `[mcp:${this.serverName}] saveTokens() ${this.tokenSummary(tokens)}`,
    );
    await this.storage.update(this.key("tokens"), tokens);
    if (this.authorizationAttempt) {
      await this.onTokensSaved?.(this.authorizationAttempt);
    }
  }

  saveCodeVerifier(verifier: string): void {
    this._codeVerifier = verifier;
  }

  codeVerifier(): string {
    return this._codeVerifier;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all" || scope === "tokens") {
      await this.deleteStored("tokens");
    }
    if (scope === "all" || scope === "client") {
      await this.deleteStored("client");
    }
  }

  /**
   * Full async browser-based OAuth flow.
   * The SDK awaits this Promise, so tokens are saved before it returns.
   * After this resolves the SDK throws UnauthorizedError — the caller
   * (McpClientHub) retries the connection immediately with the new token.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const authRedirectUri = authorizationUrl.searchParams.get("redirect_uri");
    const [clientInfo, existingTokens] = await Promise.all([
      this.readStored<OAuthClientInformationMixed>("client"),
      this.readStored<OAuthTokens>("tokens"),
    ]);
    const hasSavedTokens = Boolean(existingTokens);
    const hasRefreshToken = Boolean(existingTokens?.refresh_token);

    const attempt = this.authorizationAttempt;
    const allowInteractiveAuth = attempt?.authMode === "interactive";
    this.onLog?.(
      `[mcp:${this.serverName}] oauth authorization request redirect_uri=${authRedirectUri ?? "none"} local_redirect=${this.redirectUrl} hasSavedTokens=${hasSavedTokens} hasRefreshToken=${hasRefreshToken} authMode=${attempt?.authMode ?? "missing"} trigger=${attempt?.trigger ?? "missing"} attemptId=${attempt?.attemptId ?? "missing"}`,
    );

    if (!attempt || !allowInteractiveAuth) {
      if (attempt) {
        this.onAuthEvent?.({
          type: "browser_open_blocked",
          ...this.authEventBase(attempt),
          hasSavedTokens,
          hasRefreshToken,
          decisionReason: "suppressed_noninteractive",
        });
      }
      const suffix = hasRefreshToken
        ? " after refresh token failure"
        : hasSavedTokens
          ? " after saved token rejection"
          : "";
      this.onLog?.(
        `[mcp:${this.serverName}] suppressing interactive OAuth${suffix}; manual reauthentication required`,
      );
      throw new McpOAuthError(
        "authorization_error",
        `OAuth authorization blocked for "${this.serverName}": manual reauthentication required${suffix}`,
      );
    }

    const decision =
      this.preauthorizedDecision ??
      (await this.onBeforeAuthorizationOpen?.(attempt));
    this.preauthorizedDecision = undefined;
    if (!decision?.allowed) {
      const reason = decision?.reason ?? "blocked_manual_reauth";
      throw new McpOAuthError(
        "authorization_error",
        `OAuth authorization blocked for "${this.serverName}": ${reason}`,
      );
    }

    try {
      const currentTokenGeneration = await this.readTokenGeneration?.(
        attempt.serverIdentityHash,
      );
      if (
        !attempt.userInitiated &&
        currentTokenGeneration !== undefined &&
        currentTokenGeneration > attempt.tokenGenerationBefore
      ) {
        this.onLog?.(
          `[mcp:${this.serverName}] oauth tokens changed during connect; suppressing browser authorization and requesting silent retry generation=${attempt.tokenGenerationBefore}->${currentTokenGeneration}`,
        );
        this.onAuthEvent?.({
          type: "browser_open_blocked",
          ...this.authEventBase(attempt),
          hasSavedTokens,
          hasRefreshToken,
          tokenGenerationAfter: currentTokenGeneration,
          decisionReason: "token_generation_advanced",
        });
        throw new McpOAuthError(
          "credentials_updated",
          `OAuth credentials for "${this.serverName}" were refreshed by another connection`,
        );
      }

      if (hasRefreshToken) {
        this.onAuthEvent?.({
          type: "refresh_fallback",
          ...this.authEventBase(attempt),
          hasSavedTokens,
          hasRefreshToken,
          errorKind: "refresh_failed",
        });
        this.onLog?.(
          `[mcp:${this.serverName}] falling back to interactive OAuth despite saved refresh token; likely refresh-token grant failed or was rejected by provider. client=${this.clientSummary(clientInfo)} tokens=${this.tokenSummary(existingTokens)}`,
        );
        if (this.suppressRefreshTokenReauthPrompt) {
          this.onLog?.(
            `[mcp:${this.serverName}] suppressing interactive reauthentication prompt after refresh-token fallback; entering manual reauthenticate required state`,
          );
          throw new McpOAuthError(
            "authorization_error",
            `OAuth authorization blocked for "${this.serverName}": manual reauthentication required after refresh token failure`,
          );
        }

        const reauthAction = "Reauthenticate now";
        const selection = await vscode.window.showWarningMessage(
          `AgentLink: Automatic token refresh failed for "${this.serverName}". Reauthenticate to continue.`,
          reauthAction,
        );
        if (selection !== reauthAction) {
          this.onLog?.(
            `[mcp:${this.serverName}] user deferred interactive reauthentication after refresh-token fallback; entering manual reauthenticate required state`,
          );
          throw new McpOAuthError(
            "authorization_error",
            `OAuth authorization blocked for "${this.serverName}": manual reauthentication required after refresh token failure`,
          );
        }
        this.onLog?.(
          `[mcp:${this.serverName}] user accepted interactive reauthentication after refresh-token fallback`,
        );
      } else if (hasSavedTokens) {
        this.onLog?.(
          `[mcp:${this.serverName}] falling back to interactive OAuth with saved tokens but no refresh token available. client=${this.clientSummary(clientInfo)} tokens=${this.tokenSummary(existingTokens)}`,
        );
      }

      const hasClientRedirectMismatch = this.hasRedirectUriMismatch(clientInfo);
      if (hasClientRedirectMismatch) {
        this.onLog?.(
          `[mcp:${this.serverName}] stale oauth client registration detected before interactive auth; cached redirect URIs do not include active redirect. request retry with fresh client registration. current=${this.redirectUrl} client=${this.clientSummary(clientInfo)}`,
        );
        throw new McpOAuthError(
          "stale_client_redirect",
          `OAuth client registration for "${this.serverName}" does not match the active redirect URI`,
        );
      }

      this.onAuthEvent?.({
        type: "browser_open_requested",
        ...this.authEventBase(attempt),
        hasSavedTokens,
        hasRefreshToken,
        leaseOutcome:
          decision.lease.outcome === "acquired" ? "acquired" : "error",
        leaseWaitMs: decision.lease.waitMs,
        decisionReason:
          decision.lease.outcome === "acquired" ? "allowed" : "lease_error",
      });
      this.onLog?.(
        `[mcp:${this.serverName}] opening browser for oauth authorization trigger=${attempt.trigger} attemptId=${attempt.attemptId} lease=${decision.lease.outcome}`,
      );
      void vscode.window.showInformationMessage(
        `AgentLink: Opening browser to authorize "${this.serverName}"…`,
      );

      const browserOpened = await vscode.env.openExternal(
        vscode.Uri.parse(authorizationUrl.toString()),
      );
      this.onAuthEvent?.({
        type: "browser_open_result",
        ...this.authEventBase(attempt),
        browserOpened,
      });

      if (!browserOpened) {
        this.onLog?.(
          `[mcp:${this.serverName}] oauth browser launch cancelled or denied`,
        );
        throw new McpOAuthError(
          "authorization_error",
          `OAuth authorization failed for "${this.serverName}": browser launch cancelled by user`,
        );
      }

      // Wait for the browser to redirect back to our local server
      const callback = await this.waitForCallback();

      this.onAuthEvent?.({
        type: "oauth_callback",
        ...this.authEventBase(attempt),
        callbackOutcome: callback.oauthError ? "error" : "success",
        ...(callback.oauthError ? { errorKind: "authorization_error" } : {}),
      });
      this.onLog?.(
        `[mcp:${this.serverName}] oauth callback received hasCode=${callback.hasCode} error=${callback.oauthError ?? "none"}${callback.oauthErrorDescription ? ` errorDescription=${callback.oauthErrorDescription}` : ""}`,
      );

      if (callback.oauthError) {
        throw new McpOAuthError(
          "authorization_error",
          `OAuth authorization failed for "${this.serverName}": ${callback.oauthError}${callback.oauthErrorDescription ? ` (${callback.oauthErrorDescription})` : ""}`,
        );
      }

      const code = callback.url.searchParams.get("code");
      if (!code) {
        throw new McpOAuthError(
          "callback_missing_code",
          `OAuth callback for "${this.serverName}" did not include an authorization code`,
        );
      }

      await this.debugStateSnapshot("before authorizationCode exchange");
      this.onLog?.(
        `[mcp:${this.serverName}] exchanging authorization code for tokens`,
      );

      try {
        // Exchange the code for tokens (saves them via saveTokens)
        await auth(this, {
          serverUrl: this.serverUrl,
          authorizationCode: code,
        });
      } catch (err) {
        const detail =
          err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        this.onLog?.(
          `[mcp:${this.serverName}] authorizationCode exchange failed ${detail}`,
        );
        await this.debugStateSnapshot(
          "after failed authorizationCode exchange",
        );
        throw err;
      }

      await this.debugStateSnapshot("after authorizationCode exchange");
      void vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `AgentLink: "${this.serverName}" authorized successfully`,
          cancellable: false,
        },
        () => new Promise<void>((resolve) => setTimeout(resolve, 4_000)),
      );
    } finally {
      await decision.lease.complete();
    }
  }

  /** Clear saved tokens (e.g. on /mcp-refresh for a broken server). */
  async clearTokens(): Promise<void> {
    await this.deleteStored("tokens");
  }

  /**
   * Force a completely fresh OAuth browser flow.
   * Clears all stored credentials, then proactively calls auth() which
   * triggers redirectToAuthorization (opens browser) since nothing is cached.
   * Call this before reconnecting so the new tokens are ready.
   */
  async forceReauth(): Promise<void> {
    const attempt = this.authorizationAttempt;
    if (!attempt) {
      throw new McpOAuthError(
        "authorization_error",
        `OAuth authorization blocked for "${this.serverName}": missing authorization attempt`,
      );
    }
    const decision = await this.onBeforeAuthorizationOpen?.(attempt);
    if (!decision?.allowed) {
      throw new McpOAuthError(
        "authorization_error",
        `OAuth authorization blocked for "${this.serverName}": ${decision?.reason ?? "blocked_manual_reauth"}`,
      );
    }
    this.preauthorizedDecision = decision;
    try {
      // Hold the cross-window lease before clearing globally shared credentials.
      await this.invalidateCredentials("all");
      // auth() with no authorizationCode will discover the server and call
      // redirectToAuthorization() since we have no tokens or client info.
      await auth(this, { serverUrl: this.serverUrl });
    } finally {
      if (this.preauthorizedDecision === decision) {
        this.preauthorizedDecision = undefined;
        await decision.lease.complete();
      }
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private waitForCallback(): Promise<OAuthCallbackResult> {
    return new Promise<OAuthCallbackResult>((resolve, reject) => {
      const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      const timer = setTimeout(() => {
        this._server?.removeListener("request", handler);
        reject(
          new McpOAuthError(
            "callback_timeout",
            `OAuth timeout waiting for callback for "${this.serverName}"`,
          ),
        );
      }, TIMEOUT_MS);

      const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
        const url = new URL(req.url ?? "/", `http://localhost:${this._port}`);

        if (url.pathname !== "/callback") {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }

        clearTimeout(timer);
        this._server?.removeListener("request", handler);

        const oauthError = url.searchParams.get("error") ?? undefined;
        const oauthErrorDescription =
          url.searchParams.get("error_description") ?? undefined;
        const hasCode = Boolean(url.searchParams.get("code"));

        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(
          renderMcpOAuthCallbackPage({
            serverName: this.serverName,
            oauthError,
            oauthErrorDescription,
          }),
        );

        resolve({
          url,
          oauthError,
          oauthErrorDescription,
          hasCode,
        });
      };

      this._server?.on("request", handler);
    });
  }
}
