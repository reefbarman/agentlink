import { describe, expect, it } from "vitest";
import {
  normalizeOpenAiCompatibleConnections,
  validateOpenAiCompatibleBaseUrl,
} from "./config.js";

function model(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "local-model",
    model: "upstream/model",
    displayName: "Local model",
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    supportsToolUse: true,
    ...overrides,
  };
}

function connection(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "local",
    displayName: "Local server",
    baseUrl: "http://127.0.0.1:1234/v1/",
    profile: "generic",
    models: [model()],
    ...overrides,
  };
}

function issuePaths(
  raw: unknown,
  builtInModelIds?: Iterable<string>,
): string[] {
  return normalizeOpenAiCompatibleConnections(raw, {
    builtInModelIds,
  }).issues.map((entry) => entry.path);
}

describe("validateOpenAiCompatibleBaseUrl", () => {
  it("returns normalized transport metadata only for structurally valid URLs", () => {
    expect(
      validateOpenAiCompatibleBaseUrl("http://127.0.0.2:1234/v1/"),
    ).toEqual({
      baseUrl: "http://127.0.0.2:1234/v1",
      protocol: "http:",
      loopback: true,
      issues: [],
    });
    expect(
      validateOpenAiCompatibleBaseUrl("https://api.example.invalid/v1"),
    ).toEqual({
      baseUrl: "https://api.example.invalid/v1",
      protocol: "https:",
      loopback: false,
      issues: [],
    });
  });

  it.each([
    " ftp://example.invalid/v1",
    "ftp://example.invalid/v1",
    "https://user:pass@example.invalid/v1",
    "https://example.invalid/v1?key=value",
    "https://example.invalid/v1#fragment",
  ])(
    "rejects unsafe discovery URL %s without returning a base URL",
    (baseUrl) => {
      const result = validateOpenAiCompatibleBaseUrl(baseUrl);
      expect(result.baseUrl).toBeUndefined();
      expect(result.issues).not.toHaveLength(0);
    },
  );
});

describe("normalizeOpenAiCompatibleConnections", () => {
  it("normalizes multiple connections and converts them to core runtime profiles", () => {
    const result = normalizeOpenAiCompatibleConnections([
      connection({
        id: "openrouter",
        displayName: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        profile: "openrouter",
        authKey: "shared-key",
        timeoutMs: 42_000,
        headers: { "HTTP-Referer": "https://example.invalid/agentlink" },
        auxiliaryModel: "deepseek",
        models: [
          model({
            id: "kimi",
            model: "moonshotai/kimi",
            displayName: "Kimi",
            contextWindow: 131_072,
            maxInputTokens: 120_000,
            maxOutputTokens: 16_384,
            supportsThinking: true,
            reasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
            supportsImages: true,
          }),
          model({
            id: "deepseek",
            model: "deepseek/deepseek-chat",
            displayName: "DeepSeek",
            contextWindow: 131_072,
            maxOutputTokens: 16_384,
          }),
        ],
      }),
      connection({
        id: "direct",
        displayName: "Direct",
        baseUrl: "https://api.example.invalid/v1",
        authKey: "shared-key",
        models: [model({ id: "direct-model" })],
      }),
    ]);

    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.connections).toHaveLength(2);
    expect(result.connections[0]).toMatchObject({
      id: "openrouter",
      providerId: "openai-compatible:openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      authKey: "shared-key",
      timeoutMs: 42_000,
      auxiliaryModel: "deepseek",
    });
    expect(result.connections[0].runtimeProfile).toEqual({
      providerId: "openai-compatible:openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      profile: "openrouter",
      headers: {
        "HTTP-Referer": "https://example.invalid/agentlink",
        "X-OpenRouter-Title": "AgentLink",
        "X-OpenRouter-Categories": "ide-extension",
      },
      timeoutMs: 42_000,
      authRequired: true,
      models: {
        kimi: {
          id: "kimi",
          model: "moonshotai/kimi",
          capabilities: {
            supportsThinking: true,
            supportsCaching: false,
            supportsImages: true,
            supportsToolUse: true,
            contextWindow: 131_072,
            maxInputTokens: 120_000,
            maxOutputTokens: 16_384,
            reasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
          },
        },
        deepseek: {
          id: "deepseek",
          model: "deepseek/deepseek-chat",
          capabilities: expect.any(Object),
        },
      },
    });
    expect(result.connections[1].authKey).toBe("shared-key");
  });

  it("accepts a no-auth loopback connection and applies defaults", () => {
    const result = normalizeOpenAiCompatibleConnections([connection()]);

    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.connections[0]).toMatchObject({
      baseUrl: "http://127.0.0.1:1234/v1",
      timeoutMs: 180_000,
      allowInsecureHttp: false,
    });
    expect(result.connections[0].runtimeProfile).toMatchObject({
      authRequired: false,
      profile: "generic",
    });
    expect(result.connections[0].models[0].capabilities).toEqual({
      supportsThinking: false,
      supportsCaching: false,
      supportsImages: false,
      supportsToolUse: true,
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
    });
  });

  it("returns root and field-specific JSON paths for malformed input", () => {
    expect(issuePaths(null)).toEqual(["$"]);

    const paths = issuePaths([
      {
        id: 1,
        displayName: "",
        baseUrl: 12,
        profile: "unknown",
        models: "no",
      },
    ]);
    expect(paths).toEqual([
      "$[0].id",
      "$[0].displayName",
      "$[0].baseUrl",
      "$[0].profile",
      "$[0].models",
    ]);
  });

  it("rejects duplicate connection IDs and global model collisions", () => {
    const paths = issuePaths(
      [
        connection({ id: "same", models: [model({ id: "builtin" })] }),
        connection({ id: "same", models: [model({ id: "builtin" })] }),
      ],
      ["builtin"],
    );

    expect(paths).toEqual(
      expect.arrayContaining([
        "$[0].models[0].id",
        "$[1].id",
        "$[1].models[0].id",
      ]),
    );
    expect(paths.filter((path) => path === "$[1].models[0].id")).toHaveLength(
      2,
    );
  });

  it("rejects invalid profiles, IDs, wire IDs, and auxiliary references", () => {
    const paths = issuePaths([
      connection({
        id: "Invalid ID",
        profile: "responses",
        auxiliaryModel: "elsewhere",
        models: [model({ id: "", model: "" })],
      }),
    ]);

    expect(paths).toEqual(
      expect.arrayContaining([
        "$[0].id",
        "$[0].profile",
        "$[0].models[0].id",
        "$[0].models[0].model",
        "$[0].auxiliaryModel",
      ]),
    );
  });

  it("enforces numeric and collection bounds", () => {
    const tooManyConnections = Array.from({ length: 51 }, (_, index) =>
      connection({
        id: `connection-${index}`,
        models: [model({ id: `model-${index}` })],
      }),
    );
    expect(issuePaths(tooManyConnections)).toContain("$");

    const paths = issuePaths([
      connection({
        timeoutMs: 999,
        models: [
          model({
            contextWindow: 0,
            maxInputTokens: 40_000,
            maxOutputTokens: 100_000_001,
          }),
        ],
      }),
    ]);
    expect(paths).toEqual(
      expect.arrayContaining([
        "$[0].timeoutMs",
        "$[0].models[0].contextWindow",
        "$[0].models[0].maxOutputTokens",
      ]),
    );

    const relationPaths = issuePaths([
      connection({
        models: [
          model({
            contextWindow: 4_096,
            maxInputTokens: 4_097,
            maxOutputTokens: 4_097,
          }),
        ],
      }),
    ]);
    expect(relationPaths).toEqual(
      expect.arrayContaining([
        "$[0].models[0].maxInputTokens",
        "$[0].models[0].maxOutputTokens",
      ]),
    );
  });

  it("validates capability combinations and profile-specific reasoning", () => {
    const disabledPaths = issuePaths([
      connection({
        profile: "openrouter",
        models: [
          model({
            supportsThinking: false,
            reasoningEfforts: ["low", "low", "impossible"],
            defaultReasoningEffort: "high",
          }),
        ],
      }),
    ]);
    expect(disabledPaths).toEqual(
      expect.arrayContaining([
        "$[0].models[0].reasoningEfforts[1]",
        "$[0].models[0].reasoningEfforts[2]",
        "$[0].models[0].reasoningEfforts",
        "$[0].models[0].defaultReasoningEffort",
      ]),
    );

    const genericPaths = issuePaths([
      connection({
        models: [
          model({
            supportsThinking: true,
            reasoningEfforts: ["low", "medium"],
            defaultReasoningEffort: "high",
          }),
        ],
      }),
    ]);
    expect(genericPaths).toEqual(
      expect.arrayContaining([
        "$[0].models[0].reasoningEfforts",
        "$[0].models[0].defaultReasoningEffort",
      ]),
    );
  });

  it("rejects unsafe URLs while permitting HTTPS and loopback HTTP auth", () => {
    for (const baseUrl of [
      "ftp://example.invalid/v1",
      "https://user:pass@example.invalid/v1",
      "https://example.invalid/v1?key=value",
      "https://example.invalid/v1#fragment",
    ]) {
      expect(issuePaths([connection({ baseUrl, authKey: "key" })])).toContain(
        "$[0].baseUrl",
      );
    }

    expect(
      normalizeOpenAiCompatibleConnections([
        connection({ baseUrl: "https://example.invalid/v1", authKey: "key" }),
        connection({
          id: "localhost",
          baseUrl: "http://localhost:1234/v1",
          authKey: "key",
          models: [model({ id: "localhost-model" })],
        }),
        connection({
          id: "ipv6",
          baseUrl: "http://[::1]:1234/v1",
          authKey: "key",
          models: [model({ id: "ipv6-model" })],
        }),
      ]).issues,
    ).toEqual([]);
  });

  it("fails closed for authenticated non-loopback HTTP unless explicitly opted in", () => {
    const rejected = normalizeOpenAiCompatibleConnections([
      connection({
        baseUrl: "http://server.example.invalid/v1",
        authKey: "key",
      }),
    ]);
    expect(rejected.connections).toEqual([]);
    expect(rejected.issues).toEqual([
      expect.objectContaining({ path: "$[0].baseUrl" }),
    ]);

    const optedIn = normalizeOpenAiCompatibleConnections([
      connection({
        baseUrl: "http://server.example.invalid/v1",
        authKey: "key",
        allowInsecureHttp: true,
      }),
    ]);
    expect(optedIn.issues).toEqual([]);
    expect(optedIn.connections).toHaveLength(1);
    expect(optedIn.warnings).toEqual([
      expect.objectContaining({ path: "$[0].allowInsecureHttp" }),
    ]);
  });

  it.each([
    "Authorization",
    "Proxy-Authorization",
    "Cookie",
    "Set-Cookie",
    "X-API-Key",
    "Host",
    "Content-Length",
    "Connection",
    "Transfer-Encoding",
    "Sec-Fetch-Site",
    "X-Custom-Auth-Token",
    "X-OpenRouter-Title",
  ])("rejects reserved or credential-bearing header %s", (name) => {
    expect(
      issuePaths([connection({ headers: { [name]: "value" } })]),
    ).toContain(`$[0].headers[${JSON.stringify(name)}]`);
  });

  it("rejects invalid, duplicate-case, CRLF, and bounded headers", () => {
    const headers: Record<string, unknown> = {
      "Bad Name": "value",
      Referer: "one",
      referer: "two",
      "X-Injection": "safe\r\nAuthorization: secret",
      "X-NonString": 1,
      "X-Long": "x".repeat(8_193),
    };
    const paths = issuePaths([connection({ headers })]);

    expect(paths).toEqual(
      expect.arrayContaining([
        '$[0].headers["Bad Name"]',
        '$[0].headers["referer"]',
        '$[0].headers["X-Injection"]',
        '$[0].headers["X-NonString"]',
        '$[0].headers["X-Long"]',
      ]),
    );

    const tooManyHeaders = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`X-${index}`, "v"]),
    );
    expect(issuePaths([connection({ headers: tooManyHeaders })])).toContain(
      "$[0].headers",
    );

    const oversizedHeaders = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `X-Large-${index}`,
        "é".repeat(4_096),
      ]),
    );
    expect(issuePaths([connection({ headers: oversizedHeaders })])).toContain(
      "$[0].headers",
    );
  });

  it("does not emit profile-controlled headers for generic profiles", () => {
    const result = normalizeOpenAiCompatibleConnections([
      connection({ headers: { "HTTP-Referer": "https://example.invalid" } }),
    ]);

    expect(result.issues).toEqual([]);
    expect(result.connections[0].runtimeProfile.headers).toEqual({
      "HTTP-Referer": "https://example.invalid",
    });
  });
});
