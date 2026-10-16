import { describe, expect, it } from "vitest";
import {
  redactAuthCallbackSecrets,
  redactAuthCallbackSecretsDeep,
} from "./mcpResultRedaction.js";

import { normalizeMcpToolResult } from "./mcpToolResult.js";

const CODE = "sentinel-code-7f3a";
const STATE = "sentinel-state-91bc";
const callback = `https://auth.openai.com/deviceauth/callback?code=${CODE}&state=${STATE}`;

describe("redactAuthCallbackSecrets", () => {
  it("redacts code and state on the reviewed callback endpoint only", () => {
    const text = `1: ${callback} [selected]\n2: http://localhost:5173/closet?code=keep&state=keep`;
    const redacted = redactAuthCallbackSecrets(text);
    expect(redacted).not.toContain(CODE);
    expect(redacted).not.toContain(STATE);
    expect(redacted).toContain(
      "https://auth.openai.com/deviceauth/callback?code=REDACTED&state=REDACTED [selected]",
    );
    expect(redacted).toContain(
      "http://localhost:5173/closet?code=keep&state=keep",
    );
  });

  it("handles repeated, encoded and fragment keys while keeping other parameters", () => {
    const text = `see https://AUTH.openai.com/deviceauth/callback?scope=openid&co%64e=${CODE}&code=${CODE}2#state=${STATE}.`;
    const redacted = redactAuthCallbackSecrets(text);
    expect(redacted).not.toContain(CODE);
    expect(redacted).not.toContain(STATE);
    expect(redacted).toContain("scope=openid");
    expect(redacted.endsWith("#state=REDACTED.")).toBe(true);
  });

  it("is idempotent and leaves empty values and other auth URLs alone", () => {
    const once = redactAuthCallbackSecrets(callback);
    expect(redactAuthCallbackSecrets(once)).toBe(once);
    const untouched = [
      "https://auth.openai.com/deviceauth/callback?code=&state=",
      `https://auth.openai.com/authorize?code=${CODE}`,
      `https://example.com/deviceauth/callback?code=${CODE}`,
    ].join("\n");
    expect(redactAuthCallbackSecrets(untouched)).toBe(untouched);
  });

  it("redacts inside JSON-serialized strings without breaking the JSON", () => {
    const json = JSON.stringify({
      pages: [{ url: callback, title: "Sign in" }],
    });
    const parsed = JSON.parse(redactAuthCallbackSecrets(json));
    expect(parsed.pages[0].url).toBe(
      "https://auth.openai.com/deviceauth/callback?code=REDACTED&state=REDACTED",
    );
  });

  it("returns the original reference when nothing changes", () => {
    const value = { a: ["plain"], b: { c: 1 } };
    expect(redactAuthCallbackSecretsDeep(value)).toBe(value);
  });

  it("terminates on cyclic values", () => {
    const value: Record<string, unknown> = { url: callback };
    value.self = value;
    const redacted = redactAuthCallbackSecretsDeep(value);
    expect(redacted.url).not.toContain(CODE);
    const clean: Record<string, unknown> = { a: 1 };
    clean.self = clean;
    expect(redactAuthCallbackSecretsDeep(clean)).toBe(clean);
  });
});

describe("normalizeMcpToolResult callback redaction", () => {
  it("removes sentinels from text, structured data and metadata copies", () => {
    const raw = {
      content: [
        { type: "text" as const, text: `Pages:\n${callback}` },
        {
          type: "resource_link" as const,
          uri: callback,
          name: "callback",
        },
        {
          type: "image" as const,
          data: "aGVsbG8=",
          mimeType: "image/png",
        },
      ],
      structuredContent: { pages: [{ url: callback }] },
      _meta: { lastUrl: callback },
    };
    const normalized = normalizeMcpToolResult(raw);
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain(CODE);
    expect(serialized).not.toContain(STATE);
    expect(normalized.content).toContainEqual({
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    });
    // The transport response is not mutated.
    expect(raw.content[0]).toMatchObject({ text: `Pages:\n${callback}` });
  });
});
