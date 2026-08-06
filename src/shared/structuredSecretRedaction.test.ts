import { describe, expect, it } from "vitest";
import {
  isHighConfidenceSecretKey,
  isStructuredConfigPath,
  redactStructuredSecrets,
} from "./structuredSecretRedaction.js";

import { parse as parseToml } from "@iarna/toml";

describe("structured secret redaction", () => {
  it("gates eligible JSON/JSONC and local TOML configuration paths", () => {
    for (const filePath of [
      "/workspace/.vscode/settings.json",
      "/workspace/.agentlink/mcp.json",
      "/workspace/.claude/settings.jsonc",
      "/workspace/app.config.json",
      "/workspace/cline_mcp_settings.json",
      "/workspace/mise.toml",
      "/workspace/mise.local.toml",
      "/workspace/mise.development.local.toml",
      "/workspace/.config/mise/config.toml",
      "/workspace/.mise/config.toml",
      "/workspace/mise/config.toml",
      "/workspace/mise.production.toml",
      "/workspace/.mise.development.local.toml",
    ]) {
      expect(isStructuredConfigPath(filePath), filePath).toBe(true);
    }
    for (const filePath of [
      "/workspace/package.json",
      "/workspace/tsconfig.json",
      "/workspace/fixtures/data.json",
      "/workspace/src/settings.ts",
      "/workspace/Cargo.toml",
      "/workspace/pyproject.toml",
      "/workspace/config.toml",
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

    const result = redactStructuredSecrets("/workspace/settings.jsonc", input);

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

    const result = redactStructuredSecrets("/workspace/settings.jsonc", input);

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

    const result = redactStructuredSecrets("/workspace/settings.jsonc", input);

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
    const result = redactStructuredSecrets("/workspace/settings.jsonc", input);

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

    expect(redactStructuredSecrets("/workspace/settings.jsonc", input)).toEqual(
      {
        content: input,
        redactionCount: 0,
        redactedKeys: [],
      },
    );
  });

  it("redacts eligible mise TOML secrets while preserving valid TOML and line count", () => {
    const input = [
      "# Local development credentials",
      "[env]",
      'GITHUB_TOKEN = "github-secret"',
      'NPM_TOKEN = "npm-secret"',
      'ANTHROPIC_API_KEY = "anthropic-secret"',
      'AWS_SECRET_ACCESS_KEY = "aws-secret"',
      'SAFE_VALUE = "visible"',
      'MULTILINE_TOKEN = """first secret',
      'second secret"""',
      'inline = { safe = "visible", token = "inline-secret" }',
      "",
    ].join("\n");

    const result = redactStructuredSecrets("/workspace/mise.local.toml", input);

    expect(result.status).toBeUndefined();
    expect(result.redactionCount).toBe(6);
    expect(result.redactedKeys).toEqual([
      "ANTHROPIC_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "MULTILINE_TOKEN",
      "NPM_TOKEN",
      "token",
    ]);
    for (const secret of [
      "github-secret",
      "npm-secret",
      "anthropic-secret",
      "aws-secret",
      "first secret",
      "second secret",
      "inline-secret",
    ]) {
      expect(result.content).not.toContain(secret);
    }
    expect(result.content).toContain('SAFE_VALUE = "visible"');
    expect(result.content).toContain('safe = "visible"');
    expect(result.content.match(/\r\n|\r|\n/g)).toEqual(
      input.match(/\r\n|\r|\n/g),
    );
    expect(() => parseToml(result.content)).not.toThrow();
  });

  it("redacts TOML table and dotted-key ancestors while handling comments and CRLF", () => {
    const input = [
      "[secrets] # don't skip the following secret",
      'value = "nested-secret"',
      "[env] # it's safe to keep comments",
      'GITHUB_TOKEN = "github-secret"',
      'credentials.token = "dotted-secret"',
      "MAX_TOKENS = 4096",
      'inline = { num_tokens = 128, token = "inline-secret" }',
      "",
    ].join("\r\n");

    const result = redactStructuredSecrets("/workspace/mise.local.toml", input);

    expect(result.status).toBeUndefined();
    expect(result.redactionCount).toBe(4);
    for (const secret of [
      "nested-secret",
      "github-secret",
      "dotted-secret",
      "inline-secret",
    ]) {
      expect(result.content).not.toContain(secret);
    }
    expect(result.content).toContain("MAX_TOKENS = 4096");
    expect(result.content).toContain("num_tokens = 128");
    expect(result.content.match(/\r\n|\r|\n/g)).toEqual(
      input.match(/\r\n|\r|\n/g),
    );
    expect(() =>
      parseToml(result.content.replace(/\r\n?|\n/g, "\n")),
    ).not.toThrow();
  });

  it("does not process ineligible TOML", () => {
    const input = 'GITHUB_TOKEN = "not-a-config-secret"\n';

    expect(redactStructuredSecrets("/workspace/Cargo.toml", input)).toEqual({
      content: input,
      redactionCount: 0,
      redactedKeys: [],
    });
  });

  it("withholds malformed eligible TOML without returning raw content", () => {
    const input = '[env]\nGITHUB_TOKEN = "toml-secret"\nbroken = [\n';

    const result = redactStructuredSecrets("/workspace/mise.local.toml", input);

    expect(result).toMatchObject({
      redactionCount: 0,
      redactedKeys: [],
      status: "withheld_invalid_toml",
    });
    expect(result.content).toContain("CONTENT WITHHELD");
    expect(result.content).not.toContain("toml-secret");
    expect(() => parseToml(result.content)).not.toThrow();
    expect(result.content.match(/\r\n|\r|\n/g)).toEqual(
      input.match(/\r\n|\r|\n/g),
    );
  });

  it("withholds malformed eligible JSONC while preserving line count", () => {
    for (const input of [
      '{\n  "apiKey": "hidden",\n  "broken": }',
      '{\n  "apiKey": "hidden"\n} /* unterminated',
      '{\n  "apiKey": "hidden\n}',
      '{\n  "apiKey": "hidden"\n} trailing',
    ]) {
      const result = redactStructuredSecrets(
        "/workspace/settings.jsonc",
        input,
      );

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
