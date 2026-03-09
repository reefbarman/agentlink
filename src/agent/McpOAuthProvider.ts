import * as vscode from "vscode";
import * as http from "http";
import * as net from "net";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

function storageKey(serverName: string, suffix: string): string {
  return `mcp_oauth_${serverName}_${suffix}`;
}

/**
 * OAuthClientProvider implementation for MCP HTTP servers.
 *
 * Flow:
 * 1. `start()` binds a local HTTP server to get a dynamic port for the redirect URI.
 * 2. When the MCP transport gets a 401, the SDK calls `auth()` which in turn calls
 *    `redirectToAuthorization()`.  Our async implementation opens a browser and
 *    awaits the OAuth callback before returning, so by the time it resolves the
 *    tokens are already saved and the SDK can retry the connection.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private _port = 0;
  private _server: http.Server | null = null;
  private _codeVerifier = "";

  constructor(
    private readonly serverName: string,
    private readonly serverUrl: string,
    private readonly storage: vscode.Memento,
  ) {}

  /** Start the local callback HTTP server and capture the assigned port. */
  async start(): Promise<void> {
    if (this._server) return;
    this._server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      this._server!.listen(0, "127.0.0.1", () => {
        this._port = (this._server!.address() as net.AddressInfo).port;
        resolve();
      });
      this._server!.on("error", reject);
    });
  }

  /** Stop the callback server. */
  stop(): void {
    this._server?.close();
    this._server = null;
    this._port = 0;
  }

  // ── OAuthClientProvider interface ──────────────────────────────────────

  get redirectUrl(): string {
    return `http://127.0.0.1:${this._port}/callback`;
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

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.storage.get<OAuthClientInformationMixed>(
      storageKey(this.serverName, "client"),
    );
  }

  async saveClientInformation(
    info: OAuthClientInformationMixed,
  ): Promise<void> {
    await this.storage.update(storageKey(this.serverName, "client"), info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.storage.get<OAuthTokens>(storageKey(this.serverName, "tokens"));
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.storage.update(storageKey(this.serverName, "tokens"), tokens);
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
      await this.storage.update(
        storageKey(this.serverName, "tokens"),
        undefined,
      );
    }
    if (scope === "all" || scope === "client") {
      await this.storage.update(
        storageKey(this.serverName, "client"),
        undefined,
      );
    }
  }

  /**
   * Full async browser-based OAuth flow.
   * The SDK awaits this Promise, so tokens are saved before it returns.
   * After this resolves the SDK throws UnauthorizedError — the caller
   * (McpClientHub) retries the connection immediately with the new token.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    void vscode.window.showInformationMessage(
      `AgentLink: Opening browser to authorize "${this.serverName}"…`,
    );

    await vscode.env.openExternal(
      vscode.Uri.parse(authorizationUrl.toString()),
    );

    // Wait for the browser to redirect back to our local server
    const callbackUrl = await this.waitForCallback();

    const code = callbackUrl.searchParams.get("code");
    if (!code) {
      throw new Error(
        `OAuth callback for "${this.serverName}" did not include an authorization code`,
      );
    }

    // Exchange the code for tokens (saves them via saveTokens)
    await auth(this, { serverUrl: this.serverUrl, authorizationCode: code });

    void vscode.window.showInformationMessage(
      `AgentLink: "${this.serverName}" authorized successfully`,
    );
  }

  /** Clear saved tokens (e.g. on /mcp-refresh for a broken server). */
  async clearTokens(): Promise<void> {
    await this.storage.update(storageKey(this.serverName, "tokens"), undefined);
  }

  /**
   * Force a completely fresh OAuth browser flow.
   * Clears all stored credentials, then proactively calls auth() which
   * triggers redirectToAuthorization (opens browser) since nothing is cached.
   * Call this before reconnecting so the new tokens are ready.
   */
  async forceReauth(): Promise<void> {
    await this.invalidateCredentials("all");
    // auth() with no authorizationCode will discover the server and call
    // redirectToAuthorization() since we have no tokens or client info.
    await auth(this, { serverUrl: this.serverUrl });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private waitForCallback(): Promise<URL> {
    return new Promise<URL>((resolve, reject) => {
      const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      const timer = setTimeout(() => {
        this._server?.removeListener("request", handler);
        reject(
          new Error(
            `OAuth timeout waiting for callback for "${this.serverName}"`,
          ),
        );
      }, TIMEOUT_MS);

      const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
        clearTimeout(timer);
        this._server?.removeListener("request", handler);

        const url = new URL(req.url ?? "/", `http://127.0.0.1:${this._port}`);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<!DOCTYPE html><html><body>` +
            `<h2 style="font-family:sans-serif">Authorization complete</h2>` +
            `<p style="font-family:sans-serif">You may close this tab and return to VS Code.</p>` +
            `<script>window.close();</script>` +
            `</body></html>`,
        );

        resolve(url);
      };

      this._server?.on("request", handler);
    });
  }
}
