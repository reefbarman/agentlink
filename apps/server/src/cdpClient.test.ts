import { describe, expect, it } from "vitest";

import { cdpConnection, connectCdp, type CdpSocket } from "./cdpClient.js";

function fakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  const handlers = new Map<
    string,
    Array<(event: { data?: unknown }) => void>
  >();
  const socket: CdpSocket = {
    send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
    close: () => handlers.get("close")?.forEach((handler) => handler({})),
    addEventListener: (type, listener) => {
      handlers.set(type, [...(handlers.get(type) ?? []), listener]);
    },
  };
  const receive = (message: unknown) =>
    handlers
      .get("message")
      ?.forEach((handler) => handler({ data: JSON.stringify(message) }));
  const open = () => handlers.get("open")?.forEach((handler) => handler({}));
  return { socket, sent, receive, open };
}

describe("cdpConnection", () => {
  it("matches replies to commands, reports errors and delivers events", async () => {
    const fake = fakeSocket();
    const connection = cdpConnection(fake.socket);
    const events: string[] = [];
    connection.onEvent((event) =>
      events.push(`${event.method}@${event.sessionId ?? ""}`),
    );
    const reply = connection.send(
      "Page.navigate",
      { url: "https://x.example/" },
      "s1",
    );
    expect(fake.sent[0]).toEqual({
      id: 1,
      method: "Page.navigate",
      params: { url: "https://x.example/" },
      sessionId: "s1",
    });
    fake.receive({
      method: "Page.loadEventFired",
      params: {},
      sessionId: "s1",
    });
    fake.receive({ id: 1, result: { frameId: "f" } });
    await expect(reply).resolves.toEqual({ frameId: "f" });
    const failing = connection.send("Nope.method");
    fake.receive({ id: 2, error: { message: "not found" } });
    await expect(failing).rejects.toThrow("not found");
    expect(events).toEqual(["Page.loadEventFired@s1"]);

    const pending = connection.send("Page.reload");
    connection.close();
    await expect(pending).rejects.toThrow();
    expect(connection.closed).toBe(true);
  });
});

describe("connectCdp", () => {
  it("connects by address, since DevTools refuses other Host headers", async () => {
    const fake = fakeSocket();
    const urls: string[] = [];
    const connecting = connectCdp("agentlink-browser-b-1", 9222, {
      lookup: async () => "172.30.0.5",
      fetch: (async (url: string) => {
        urls.push(url);
        return new Response(
          JSON.stringify({
            webSocketDebuggerUrl:
              "ws://agentlink-browser-b-1:9222/devtools/browser/abc",
          }),
        );
      }) as unknown as typeof fetch,
      createSocket: (url) => {
        urls.push(url);
        setTimeout(fake.open, 1);
        return fake.socket;
      },
    });
    const connection = await connecting;
    expect(urls).toEqual([
      "http://172.30.0.5:9222/json/version",
      "ws://172.30.0.5:9222/devtools/browser/abc",
    ]);
    connection.close();
  });
});
