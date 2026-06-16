import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceConfig: Record<string, unknown> = {};

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (_section: string) => ({
      get: <T>(key: string, fallback: T): T => {
        return (workspaceConfig[key] as T | undefined) ?? fallback;
      },
      inspect: (key: string) => {
        const value = workspaceConfig[key];
        return value === undefined ? undefined : { globalValue: value };
      },
    }),
  },
}));

import type { ModelProvider } from "./providers/types";
import {
  detectQuestion,
  getQuestionDetectionMode,
  type QuestionDetectionMode,
} from "./questionDetectionLlm";
import type { OpenAiCompatibleEndpoint } from "./openaiCompatibleClient";

const BASE_ENDPOINT: OpenAiCompatibleEndpoint = {
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "qwen3.5-2b",
  apiKey: "",
  timeoutMs: 5000,
};

function buildChatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getQuestionDetectionMode", () => {
  beforeEach(() => {
    for (const key of Object.keys(workspaceConfig)) {
      delete workspaceConfig[key];
    }
  });

  it("falls back to heuristic by default", () => {
    expect(getQuestionDetectionMode()).toBe("heuristic");
  });

  it("uses explicit mode when configured", () => {
    workspaceConfig["questionDetection.mode"] =
      "agent" satisfies QuestionDetectionMode;
    expect(getQuestionDetectionMode()).toBe("agent");
  });

  it("maps legacy llmEnabled=true to openai mode", () => {
    workspaceConfig["questionDetection.llmEnabled"] = true;
    expect(getQuestionDetectionMode()).toBe("openai");
  });
});

describe("detectQuestion", () => {
  it("returns fallback when disabled", async () => {
    const fetchMock = vi.fn();
    const result = await detectQuestion("Proceed?", {
      mode: "heuristic",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.fallback).toBe(true);
    expect(result.detected).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns no fallback and null for blank text", async () => {
    const fetchMock = vi.fn();
    const result = await detectQuestion("   ", {
      mode: "openai",
      endpoint: BASE_ENDPOINT,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.fallback).toBe(false);
    expect(result.detected).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a properly shaped POST and returns the detected question", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      buildChatResponse(
        JSON.stringify({
          kind: "yes_no",
          prompt: "Proceed with the next task?",
          options: [{ label: "Yes" }, { label: "No" }],
        }),
      ),
    );

    const result = await detectQuestion("I finished that. Should I continue?", {
      mode: "openai",
      endpoint: BASE_ENDPOINT,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("qwen3.5-2b");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(300);
    expect(body.response_format.type).toBe("json_schema");
    expect(Array.isArray(body.messages)).toBe(true);

    expect(result.fallback).toBe(false);
    expect(result.mode).toBe("openai");
    expect(result.detected?.kind).toBe("yes_no");
    expect(result.detected?.prompt).toBe("Proceed with the next task?");
  });

  it("skips LLM detection for acknowledgement text mentioning a continue button", async () => {
    const fetchMock = vi.fn();
    const result = await detectQuestion(
      "Acknowledged — the final-status continue button works with the updated subtle rendering.",
      {
        mode: "openai",
        endpoint: BASE_ENDPOINT,
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
    );

    expect(result).toEqual({
      detected: null,
      fallback: false,
      mode: "openai",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits model field when config.model is empty", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(buildChatResponse(JSON.stringify({ kind: "none" })));

    await detectQuestion("Should I continue?", {
      mode: "openai",
      endpoint: { ...BASE_ENDPOINT, model: "" },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect("model" in body).toBe(false);
  });

  it("sends Authorization header when apiKey is set", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(buildChatResponse(JSON.stringify({ kind: "none" })));

    await detectQuestion("Anything?", {
      mode: "openai",
      endpoint: { ...BASE_ENDPOINT, apiKey: "sk-test" },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const headers = (fetchMock.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
  });

  it("falls back when the server returns a non-2xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("server exploded", { status: 500 }));

    const result = await detectQuestion("Proceed?", {
      mode: "openai",
      endpoint: BASE_ENDPOINT,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.fallback).toBe(true);
    expect(result.error).toContain("http 500");
  });

  it("falls back when fetch rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await detectQuestion("Proceed?", {
      mode: "openai",
      endpoint: BASE_ENDPOINT,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.fallback).toBe(true);
    expect(result.error).toBe("ECONNREFUSED");
  });

  it("falls back when response content is empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(buildChatResponse(""));
    const result = await detectQuestion("Proceed?", {
      mode: "openai",
      endpoint: BASE_ENDPOINT,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.fallback).toBe(true);
    expect(result.error).toBe("empty response");
  });

  it("returns null detected (no fallback) when LLM says kind=none", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(buildChatResponse(JSON.stringify({ kind: "none" })));
    const result = await detectQuestion("Should I continue?", {
      mode: "openai",
      endpoint: BASE_ENDPOINT,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.fallback).toBe(false);
    expect(result.detected).toBeNull();
  });

  it("falls back in agent mode when no provider is available", async () => {
    const result = await detectQuestion("Proceed?", { mode: "agent" });
    expect(result.fallback).toBe(true);
    expect(result.error).toBe("no active agent provider");
    expect(result.mode).toBe("agent");
  });

  it("delegates to provider.complete in agent mode and parses JSON", async () => {
    const completeMock = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        kind: "single_choice",
        prompt: "Next step?",
        options: [{ label: "Ship it" }, { label: "Add tests" }],
      }),
    });
    const provider = {
      id: "mock",
      condenseModel: "mock-haiku",
      complete: completeMock,
    } as unknown as ModelProvider;

    const result = await detectQuestion("Pick next step.", {
      mode: "agent",
      agent: { provider, model: "mock-opus" },
    });

    expect(completeMock).toHaveBeenCalledOnce();
    const call = completeMock.mock.calls[0][0];
    expect(call).toMatchObject({
      model: "mock-haiku",
      maxTokens: 300,
      temperature: 0,
      reasoningEffort: "none",
    });
    expect(result.fallback).toBe(false);
    expect(result.detected?.kind).toBe("single_choice");
    expect(result.detected?.options.map((o) => o.label)).toEqual([
      "Ship it",
      "Add tests",
    ]);
  });

  it("returns fallback=true in agent mode when provider.complete throws", async () => {
    const provider = {
      id: "mock",
      condenseModel: "mock-haiku",
      complete: vi.fn().mockRejectedValue(new Error("rate limited")),
    } as unknown as ModelProvider;

    const result = await detectQuestion("Proceed?", {
      mode: "agent",
      agent: { provider, model: "mock-haiku" },
    });
    expect(result.fallback).toBe(true);
    expect(result.error).toBe("rate limited");
  });
});
