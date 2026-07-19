import { describe, expect, it } from "vitest";
import {
  isHighConfidenceSecretKey,
  isStructuredConfigPath,
  redactStructuredSecrets,
} from "./structuredSecretRedaction.js";

describe("structured secret redaction", () => {
  it("gates only JSON/JSONC paths with config semantics", () => {
    for (const filePath of [
      "/workspace/.vscode/settings.json",
      "/workspace/.agentlink/mcp.json",
      "/workspace/.claude/settings.jsonc",
      "/workspace/app.config.json",
      "/workspace/cline_mcp_settings.json",
    ]) {
      expect(isStructuredConfigPath(filePath), filePath).toBe(true);
    }
    for (const filePath of [
      "/workspace/package.json",
      "/workspace/tsconfig.json",
      "/workspace/fixtures/data.json",
      "/workspace/src/settings.ts",
    ]) {
      expect(isStructuredConfigPath(filePath), filePath).toBe(false);
    }
  });

  it("classifies high-confidence secret keys without matching generic names", () => {
    for (const key of [
      "api_key",
      "openaiApiKey",
      "accessToken",
      "idToken",
      "awsSecretAccessKey",
      "client-secret",
      "authorization",
      "password",
      "privateKey",
      "token",
      "secret",
    ]) {
      expect(isHighConfidenceSecretKey(key), key).toBe(true);
    }
    for (const key of [
      "key",
      "auth",
      "tokenBudget",
      "validToken",
      "androidToken",
      "secretFeatureEnabled",
      "passwordPolicy",
      "publicKey",
      "keyboardShortcut",
      "monkey",
    ]) {
      expect(isHighConfidenceSecretKey(key), key).toBe(false);
    }
  });

  it("redacts nested scalar, object, and array values while preserving JSONC", () => {
    const input = `{
  // Keep comments and formatting.
  "name": "demo",
  "apiKey": "sk-secret-value",
  "nested": {
    "access_token": "token-value",
    "passwordPolicy": "strict"
  },
  "credentials": {
    "username": "demo",
    "password": "hidden"
  },
  "items": [
    { "client_secret": "client-secret", "enabled": true },
  ],
}`;

    const result = redactStructuredSecrets(input);

    expect(result.redactionCount).toBe(4);
    expect(result.redactedKeys).toEqual([
      "access_token",
      "apiKey",
      "client_secret",
      "password",
    ]);
    expect(result.content).toContain("// Keep comments and formatting.");
    expect(result.content).toContain('"name": "demo"');
    expect(result.content).toContain('"passwordPolicy": "strict"');
    expect(result.content).not.toContain("sk-secret-value");
    expect(result.content).not.toContain("token-value");
    expect(result.content).not.toContain("client-secret");
    expect(result.content).toContain('"username": "demo"');
    expect(result.content).not.toContain('"password": "hidden"');
    expect(result.content.split("\n")).toHaveLength(input.split("\n").length);
  });

  it("redacts secret arrays and multiline objects without changing line count", () => {
    const input = `{
  "tokens": [
    "first",
    "second"
  ],
  "clientSharedSecret": {
    "value": "third"
  },
  "safe": true
}`;

    const result = redactStructuredSecrets(input);

    expect(result.redactionCount).toBe(2);
    expect(result.content).toContain('"safe": true');
    expect(result.content).not.toContain("first");
    expect(result.content).not.toContain("third");
    expect(result.content.split("\n")).toHaveLength(input.split("\n").length);
  });

  it("handles escaped strings, comments inside strings, and duplicate keys", () => {
    const input = JSON.stringify({
      note: "not // a comment or /* block */",
      apiKey: "escaped-key-secret",
      token: "first-secret",
      safe: 'quote: " and slash: \\',
    })
      .replace(
        '"token":"first-secret"',
        '"token":"first-secret","token":"second-secret"',
      )
      .replace('"apiKey"', '"api\\u004bey"');

    const result = redactStructuredSecrets(input);

    expect(result.status).toBeUndefined();
    expect(result.redactionCount).toBe(3);
    expect(result.content).toContain(
      '"note":"not // a comment or /* block */"',
    );
    expect(result.content).toContain('"safe":"quote: \\\" and slash: \\\\"');
    expect(result.content).not.toContain("escaped-key-secret");
    expect(result.content).not.toContain("first-secret");
    expect(result.content).not.toContain("second-secret");
  });

  it("preserves CRLF, LF, and bare CR sequences in redacted spans", () => {
    const input =
      '{\r\n  "tokens": [\r    "first",\n    "second"\r\n  ],\r\n  "safe": true\r\n}';
    const result = redactStructuredSecrets(input);

    expect(result.content.match(/\r\n|\r|\n/g)).toEqual(
      input.match(/\r\n|\r|\n/g),
    );
    expect(result.content).not.toContain("first");
    expect(result.content).toContain('"safe": true');
  });

  it("leaves ordinary structured content unchanged", () => {
    const input = JSON.stringify({
      key: "value",
      auth: "oauth",
      tokenBudget: 2048,
      publicKey: "public material",
    });

    expect(redactStructuredSecrets(input)).toEqual({
      content: input,
      redactionCount: 0,
      redactedKeys: [],
    });
  });

  it("withholds malformed eligible JSONC while preserving line count", () => {
    for (const input of [
      '{\n  "apiKey": "hidden",\n  "broken": }',
      '{\n  "apiKey": "hidden"\n} /* unterminated',
      '{\n  "apiKey": "hidden\n}',
      '{\n  "apiKey": "hidden"\n} trailing',
    ]) {
      const result = redactStructuredSecrets(input);

      expect(result).toMatchObject({
        redactionCount: 0,
        redactedKeys: [],
        status: "withheld_invalid_jsonc",
      });
      expect(result.content).not.toContain("hidden");
      expect(result.content).toContain("CONTENT WITHHELD");
      expect(result.content.match(/\r\n|\r|\n/g)).toEqual(
        input.match(/\r\n|\r|\n/g),
      );
    }
  });
});
