import { beforeEach, describe, expect, it, vi } from "vitest";

const undiciMock = vi.hoisted(() => {
  class Agent {
    constructor(readonly options: unknown) {
      state.agents.push(this);
    }
  }
  class EnvHttpProxyAgent {
    constructor(readonly options: unknown) {
      state.proxyAgents.push(this);
    }
  }
  const state = {
    agents: [] as Agent[],
    proxyAgents: [] as EnvHttpProxyAgent[],
    fetch: vi.fn(
      async (_input: unknown, _init: unknown) =>
        new Response('{"text":"hi"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
    Agent,
    EnvHttpProxyAgent,
  };
  return state;
});

vi.mock("undici", () => ({
  Agent: undiciMock.Agent,
  EnvHttpProxyAgent: undiciMock.EnvHttpProxyAgent,
  fetch: undiciMock.fetch,
}));

const {
  CODEX_TRANSCRIPTION_TLS_CIPHERS,
  createCodexTranscriptionFetch,
  getDefaultCodexTranscriptionFetch,
} = await import("./transcriptionFetch.js");
const { transcribeCodexAudio } = await import("./transcription.js");

beforeEach(() => {
  undiciMock.agents.length = 0;
  undiciMock.proxyAgents.length = 0;
  undiciMock.fetch.mockClear();
});

describe("createCodexTranscriptionFetch", () => {
  it("sends requests through an agent with restricted ciphers", async () => {
    const fetch = createCodexTranscriptionFetch({ env: {} });
    expect(undiciMock.agents).toHaveLength(0);

    const init = { method: "POST", body: "x" };
    const response = await fetch("https://chatgpt.com/x", init);
    await fetch("https://chatgpt.com/y");

    expect(undiciMock.agents).toHaveLength(1);
    expect(undiciMock.agents[0]!.options).toEqual({
      allowH2: true,
      connect: { ciphers: CODEX_TRANSCRIPTION_TLS_CIPHERS },
    });
    expect(undiciMock.fetch).toHaveBeenCalledWith("https://chatgpt.com/x", {
      ...init,
      dispatcher: undiciMock.agents[0],
    });
    expect(await response.json()).toEqual({ text: "hi" });
    for (const cipher of CODEX_TRANSCRIPTION_TLS_CIPHERS.split(":")) {
      expect(cipher).toMatch(/^ECDHE-.*(GCM|CHACHA20)/u);
    }
  });

  it("tunnels through proxy environment variables with the same ciphers", async () => {
    await createCodexTranscriptionFetch({
      ciphers: "ECDHE-RSA-AES128-GCM-SHA256",
      env: { HTTPS_PROXY: "http://proxy.local:8080" },
    })("https://chatgpt.com/x");

    expect(undiciMock.agents).toHaveLength(0);
    const tls = { ciphers: "ECDHE-RSA-AES128-GCM-SHA256" };
    expect(undiciMock.proxyAgents[0]!.options).toEqual({
      allowH2: true,
      connect: tls,
      requestTls: tls,
    });
  });
});

describe("transcribeCodexAudio default fetch", () => {
  it("uses the TLS-restricted fetch when none is supplied", async () => {
    expect(getDefaultCodexTranscriptionFetch()).toBe(
      getDefaultCodexTranscriptionFetch(),
    );
    const result = await transcribeCodexAudio({
      context: { principalId: "p" },
      credentialProvider: {
        resolveAuth: async () => ({
          method: "oauth",
          bearerToken: "token",
          accountId: "account",
          oauthAccountPoolId: "pool",
          canRefresh: false,
        }),
        refreshAuth: async () => null,
      },
      audio: { data: new Uint8Array([1, 2]), mimeType: "audio/wav" },
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.text).toBe("hi");
    expect(undiciMock.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = undiciMock.fetch.mock.calls[0]!;
    expect(String(url)).toContain("chatgpt.com");
    expect((init as { dispatcher?: unknown }).dispatcher).toBeDefined();
  });
});
