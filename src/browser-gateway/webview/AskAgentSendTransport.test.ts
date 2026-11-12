import {
  ASK_AGENT_SEND_ACK_TIMEOUT_MS,
  AskAgentSendTransport,
  AskAgentSendUnconfirmedError,
} from "./AskAgentSendTransport";
import { afterEach, describe, expect, it, vi } from "vitest";

const payload = { sessionId: "chat-a", text: "Research this", images: [] };
const accepted = () =>
  new Response(JSON.stringify({ ok: true }), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AskAgentSendTransport", () => {
  it("requests an acknowledgement and shares simultaneous submissions", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(
      () => new Promise<Response>((done) => (resolve = done)),
    );
    vi.stubGlobal("fetch", fetch);
    const transport = new AskAgentSendTransport();
    const id = transport.reserveMessageId("draft");
    const first = transport.send("draft", payload, "token");
    expect(transport.send("draft", payload, "token")).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ask-agent/send");
    expect(JSON.parse(String(init.body))).toEqual({
      ...payload,
      id,
      acknowledge: true,
    });
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toMatchObject({ Authorization: "Bearer token" });
    resolve(accepted());
    await expect(first).resolves.toMatchObject({ body: { ok: true } });
    expect(transport.reserveMessageId("draft")).not.toBe(id);
  });

  it("bounds stalled fetches, retries the exact id, and retains it for a restored draft", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);
    const transport = new AskAgentSendTransport();
    const id = transport.reserveMessageId("draft");
    const result = transport
      .send("draft", payload, "token")
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(ASK_AGENT_SEND_ACK_TIMEOUT_MS * 2);
    expect(await result).toBeInstanceOf(AskAgentSendUnconfirmedError);
    expect(fetch).toHaveBeenCalledTimes(2);
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][1].body).toBe(calls[1][1].body);
    expect(calls.every(([, init]) => init.signal?.aborted)).toBe(true);
    expect(transport.reserveMessageId("draft")).toBe(id);
    fetch.mockImplementation(async () => accepted());
    await expect(
      transport.send("draft", payload, "token"),
    ).resolves.toMatchObject({ body: { ok: true } });
    expect(
      JSON.parse(
        String(
          (fetch.mock.calls[2] as unknown as [string, RequestInit])[1].body,
        ),
      ).id,
    ).toBe(id);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats an identical message as new after its original draft is discarded", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve))),
    );
    const transport = new AskAgentSendTransport();
    const oldId = transport.reserveMessageId("yes");
    const oldRequest = transport.send("yes", payload, "token");
    transport.discardDraft();
    const newId = transport.reserveMessageId("yes");
    expect(newId).not.toBe(oldId);
    const newRequest = transport.send("yes", payload, "token");
    expect(newRequest).not.toBe(oldRequest);
    resolvers[0](accepted());
    await oldRequest;
    expect(transport.reserveMessageId("yes")).toBe(newId);
    resolvers[1](accepted());
    await newRequest;
  });

  it("bounds retained draft identities without evicting an uncertain submission", () => {
    const transport = new AskAgentSendTransport();
    const id = transport.reserveMessageId("draft-0");
    for (let i = 1; i < 16; i++) transport.reserveMessageId(`draft-${i}`);
    expect(() => transport.reserveMessageId("overflow")).toThrow(
      AskAgentSendUnconfirmedError,
    );
    expect(transport.reserveMessageId("draft-0")).toBe(id);
    transport.discardDraft();
    expect(transport.reserveMessageId("draft-0")).not.toBe(id);
  });

  it("bounds a stalled response body too", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => ({
      status: 200,
      json: () => new Promise(() => {}),
    }));
    vi.stubGlobal("fetch", fetch);
    const transport = new AskAgentSendTransport();
    const result = transport
      .send("draft", payload, "token")
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(ASK_AGENT_SEND_ACK_TIMEOUT_MS * 2);
    expect(await result).toBeInstanceOf(AskAgentSendUnconfirmedError);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a known rejection", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "queue_full" }), { status: 409 }),
    );
    vi.stubGlobal("fetch", fetch);
    const transport = new AskAgentSendTransport();
    await expect(
      transport.send("draft", payload, "token"),
    ).resolves.toMatchObject({ status: 409, body: { error: "queue_full" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains the id after server errors or a lost acknowledgement, but does not replay an accepted long turn", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const transport = new AskAgentSendTransport();
    const id = transport.reserveMessageId("draft");
    await expect(
      transport.send("draft", payload, "token"),
    ).rejects.toBeInstanceOf(AskAgentSendUnconfirmedError);
    expect(transport.reserveMessageId("draft")).toBe(id);
    fetch.mockImplementation(async () => accepted());
    await transport.send("draft", payload, "token");
    await vi.advanceTimersByTimeAsync(10 * ASK_AGENT_SEND_ACK_TIMEOUT_MS);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(transport.reserveMessageId("other-session-draft")).not.toBe(id);
    expect(vi.getTimerCount()).toBe(0);
  });
});
