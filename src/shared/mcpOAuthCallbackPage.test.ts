import { describe, expect, it } from "vitest";

import { renderMcpOAuthCallbackPage } from "./mcpOAuthCallbackPage.js";

describe("renderMcpOAuthCallbackPage", () => {
  it("preserves the branded VS Code success page by default", () => {
    const html = renderMcpOAuthCallbackPage({ serverName: "linear" });

    expect(html).toContain("#4EC9B0");
    expect(html).toContain("You're connected");
    expect(html).toContain("linear is now ready to use in AgentLink.");
    expect(html).toContain("You can return to VS Code.");
    expect(html).toContain("prefers-color-scheme: light");
    expect(html).toContain("window.setTimeout(() => window.close(), 1800)");
  });

  it("renders desktop authorization as pending rather than connected", () => {
    const html = renderMcpOAuthCallbackPage({
      serverName: '<linear & "friends">',
      returnTarget: "desktop",
      pendingSetup: true,
    });

    expect(html).toContain("#4EC9B0");
    expect(html).toContain("Authorization received");
    expect(html).toContain("Finishing setup");
    expect(html).toContain("AgentLink is finishing setup");
    expect(html).toContain("You can return to AgentLink Desktop.");
    expect(html).toContain("&lt;linear &amp; &quot;friends&quot;&gt;");
    expect(html).not.toContain("You're connected");
    expect(html).not.toContain("Authentication successful");
    expect(html).not.toContain("is now ready to use");
    expect(html).not.toContain("VS Code");
  });

  it("renders escaped server names without exposing provider errors", () => {
    const html = renderMcpOAuthCallbackPage({
      serverName: `<linear & "friends" 'team'>`,
      oauthError: "access_denied<script>",
      oauthErrorDescription: "No <access> & try again",
    });

    expect(html).toContain("Authorization failed");
    expect(html).toContain(
      "Authorization was declined or could not be completed.",
    );
    expect(html).toContain(
      "&lt;linear &amp; &quot;friends&quot; &#39;team&#39;&gt;",
    );
    expect(html).not.toContain("access_denied");
    expect(html).not.toContain("No &lt;access&gt; &amp; try again");
    expect(html).not.toContain("No <access> & try again");
    expect(html).toContain("window.setTimeout(() => window.close(), 8000)");
  });

  it("prioritizes desktop errors over pending setup and omits secrets", () => {
    const html = renderMcpOAuthCallbackPage({
      serverName: "linear",
      returnTarget: "desktop",
      pendingSetup: true,
      oauthError: "access_denied secret-token-value",
      oauthErrorDescription: "access_token=provider-token-value",
    });

    expect(html).toContain("Authorization failed");
    expect(html).toContain("Return to AgentLink Desktop to try again.");
    expect(html).not.toContain("Finishing setup");
    expect(html).not.toContain("Authorization received");
    expect(html).not.toContain("VS Code");
    expect(html).not.toContain("secret-token-value");
    expect(html).not.toContain("provider-token-value");
  });
});
