import { describe, expect, it } from "vitest";

import { mcpStartupDiagnostic } from "./mcpStartupDiagnostic.js";

describe("mcpStartupDiagnostic", () => {
  it("keeps the cause while redacting configured credentials and OAuth output", () => {
    const diagnostic = mcpStartupDiagnostic(
      "Connection closed",
      '\u001b[31mHTTP 503\u001b[0m\nconfigured-secret inherited-secret Bearer bearer-secret\n{"refresh_token":"refresh-secret","client_secret":"client-secret"}\nhttps://auth.example.test/?code=callback-secret&state=state-secret\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
      { name: "linear", command: "npx", env: { KEY: "configured-secret" } },
      { SERVICE_TOKEN: "inherited-secret" },
    );
    expect(diagnostic).toContain("Connection closed");
    expect(diagnostic).toContain("HTTP 503");
    for (const secret of [
      "configured-secret",
      "inherited-secret",
      "bearer-secret",
      "refresh-secret",
      "client-secret",
      "callback-secret",
      "state-secret",
      "eyJhbGciOiJIUzI1NiJ9",
    ]) {
      expect(diagnostic).not.toContain(secret);
    }
    expect(diagnostic).not.toContain("\u001b");
  });

  it("preserves harmless package names, flags, and environment values", () => {
    const diagnostic = mcpStartupDiagnostic(
      "mcp-remote@0.1.25 failed with npm 404",
      "DEBUG=1 ENABLED=true",
      {
        name: "linear",
        command: "npx",
        args: ["-y", "mcp-remote@0.1.25"],
        env: { DEBUG: "1", ENABLED: "true" },
      },
    );
    expect(diagnostic).toContain("mcp-remote@0.1.25 failed with npm 404");
    expect(diagnostic).toContain("DEBUG=1 ENABLED=true");
  });

  it("redacts credential flags, inherited key/PAT/DSN names, and non-HTTP URLs", () => {
    const diagnostic = mcpStartupDiagnostic(
      "Connection closed",
      "flag-secret header-secret key-secret pat-secret dsn-secret postgres://user:password@host/db",
      {
        name: "linear",
        command: "npx",
        args: [
          "--api-key=flag-secret",
          "--header",
          "Authorization: Bearer header-secret",
        ],
      },
      {
        OPENAI_KEY: "key-secret",
        GH_PAT: "pat-secret",
        SENTRY_DSN: "dsn-secret",
      },
    );
    for (const value of [
      "flag-secret",
      "header-secret",
      "key-secret",
      "pat-secret",
      "dsn-secret",
      "user:password",
    ])
      expect(diagnostic).not.toContain(value);
  });

  it("redacts before bounding the displayed output", () => {
    const secret = "sensitive-credential";
    const diagnostic = mcpStartupDiagnostic(
      "Connection closed",
      `${"x".repeat(8175)}${secret}`,
      {
        name: "linear",
        command: "npx",
        headers: { Authorization: secret },
      },
    );
    expect(diagnostic.length).toBeLessThanOrEqual(8192);
    expect(diagnostic).not.toContain("sensitive-");
  });
});
