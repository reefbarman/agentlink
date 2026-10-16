import {
  CODEX_TRANSCRIBE_URL,
  CODEX_TRANSCRIPTION_MAX_AUDIO_BYTES,
  CodexTranscriptionError,
  OPENAI_API_KEY_TRANSCRIPTION_MODEL,
  transcribeCodexAudio,
} from "./transcription.js";
import type {
  CodexCredentialProvider,
  CodexResolvedAuth,
} from "./credentialResolution.js";
import { describe, expect, it, vi } from "vitest";

interface TestContext {
  principalId: string;
}

const context: TestContext = { principalId: "tenant:user" };
const audio = {
  data: new Uint8Array([1, 2, 3, 4]),
  mimeType: "audio/wav",
};
const env = {} as NodeJS.ProcessEnv;

function oauth(token = "oauth-token"): CodexResolvedAuth {
  return {
    method: "oauth",
    bearerToken: token,
    accountId: "chatgpt-account",
    oauthAccountPoolId: "pool-1",
    canRefresh: true,
  };
}

function provider(
  auth: CodexResolvedAuth | null,
  refreshed?: CodexResolvedAuth,
): CodexCredentialProvider<TestContext> {
  return {
    resolveAuth: vi.fn(async () => auth),
    refreshAuth: vi.fn(async () => refreshed ?? null),
  };
}

/** Parses the request's multipart body with the platform's own parser. */
async function readForm(init: RequestInit): Promise<FormData> {
  const headers = init.headers as Record<string, string>;
  expect(init.body).toBeInstanceOf(Uint8Array);
  return await new Response(init.body as Uint8Array<ArrayBuffer>, {
    headers: { "content-type": headers["Content-Type"]! },
  }).formData();
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("transcribeCodexAudio", () => {
  it("posts multipart audio to the ChatGPT transcribe endpoint with OAuth identity", async () => {
    const fetch = vi.fn(async () => jsonResponse({ text: "  hello there " }));
    const credentialProvider = provider(oauth());

    const result = await transcribeCodexAudio({
      credentialProvider,
      context,
      audio,
      language: "en",
      fetch,
      env,
    });

    expect(result).toEqual({ text: "hello there", method: "oauth" });
    expect(credentialProvider.resolveAuth).toHaveBeenCalledWith({
      context,
      modelId: "transcribe",
      purpose: "transcription",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CODEX_TRANSCRIBE_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer oauth-token");
    expect(headers["ChatGPT-Account-Id"]).toBe("chatgpt-account");
    expect(headers.originator).toBe("agentlink");
    expect(headers["Content-Type"]).toMatch(
      /^multipart\/form-data; boundary=----agentlink[0-9a-f]{24}$/u,
    );
    const form = await readForm(init);
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.wav");
    expect(file.type).toBe("audio/wav");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio.data);
    expect(form.get("language")).toBe("en");
    expect(form.get("model")).toBeNull();
  });

  it("uses the public Audio API with a model for API-key credentials", async () => {
    const fetch = vi.fn(async () => jsonResponse({ text: "from api" }));

    const result = await transcribeCodexAudio({
      credentialProvider: provider({
        method: "apiKey",
        bearerToken: "sk-test",
        canRefresh: false,
      }),
      context,
      audio: { ...audio, mimeType: "audio/webm;codecs=opus" },
      fetch,
      env,
    });

    expect(result).toEqual({ text: "from api", method: "apiKey" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    const headers = init.headers as Record<string, string>;
    expect(headers.originator).toBeUndefined();
    const form = await readForm(init);
    expect(form.get("model")).toBe(OPENAI_API_KEY_TRANSCRIPTION_MODEL);
    expect(form.get("response_format")).toBe("json");
    expect((form.get("file") as File).name).toBe("audio.webm");
  });

  it("refreshes an expired OAuth token once and retries", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ text: "retried" }));
    const credentialProvider = provider(oauth("old"), oauth("new"));

    const result = await transcribeCodexAudio({
      credentialProvider,
      context,
      audio,
      fetch,
      env,
    });

    expect(result.text).toBe("retried");
    expect(credentialProvider.refreshAuth).toHaveBeenCalledTimes(1);
    const retryHeaders = (fetch.mock.calls[1]![1] as RequestInit)
      .headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe("Bearer new");
  });

  it("reports a Cloudflare challenge distinctly", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("<html>Just a moment...</html>", {
          status: 403,
          headers: { "cf-mitigated": "challenge" },
        }),
    );

    await expect(
      transcribeCodexAudio({
        credentialProvider: provider(oauth()),
        context,
        audio,
        fetch,
        env,
      }),
    ).rejects.toMatchObject({
      name: "CodexTranscriptionError",
      code: "challenge_blocked",
      status: 403,
    });
  });

  it("requires a credential before sending audio", async () => {
    const fetch = vi.fn();

    await expect(
      transcribeCodexAudio({
        credentialProvider: provider(null),
        context,
        audio,
        fetch,
        env,
      }),
    ).rejects.toMatchObject({ code: "auth_required" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects empty and oversized audio without a request", async () => {
    const fetch = vi.fn();
    const credentialProvider = provider(oauth());

    await expect(
      transcribeCodexAudio({
        credentialProvider,
        context,
        audio: { ...audio, data: new Uint8Array() },
        fetch,
        env,
      }),
    ).rejects.toMatchObject({ code: "audio_empty" });
    await expect(
      transcribeCodexAudio({
        credentialProvider,
        context,
        audio: {
          ...audio,
          data: new Uint8Array(CODEX_TRANSCRIPTION_MAX_AUDIO_BYTES + 1),
        },
        fetch,
        env,
      }),
    ).rejects.toMatchObject({ code: "audio_too_large" });
    expect(fetch).not.toHaveBeenCalled();
    expect(credentialProvider.resolveAuth).not.toHaveBeenCalled();
  });

  it("summarizes JSON error details and rejects responses without text", async () => {
    await expect(
      transcribeCodexAudio({
        credentialProvider: provider(oauth()),
        context,
        audio,
        fetch: vi.fn(async () =>
          jsonResponse({ detail: "bad audio" }, { status: 400 }),
        ),
        env,
      }),
    ).rejects.toThrow("Transcription failed (HTTP 400): bad audio.");

    const error = await transcribeCodexAudio({
      credentialProvider: provider(oauth()),
      context,
      audio,
      fetch: vi.fn(async () => jsonResponse({ asset_pointer: "x" })),
      env,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexTranscriptionError);
    expect(error).toMatchObject({ code: "invalid_response" });
  });
});
