import http from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  decodeEntities,
  directConnector,
  fetchWebPage,
  gatewayConnector,
  htmlToText,
  webFetchTarget,
  WebFetchError,
  type WebConnector,
} from "./webFetch.js";
import type { NetworkPolicy } from "./egressPolicy.js";

const OPEN: NetworkPolicy = { preset: "open", allow: [] };
const DEPENDENCIES: NetworkPolicy = { preset: "dependencies", allow: [] };
const signal = new AbortController().signal;

describe("webFetchTarget", () => {
  it("upgrades http to https and drops the fragment", () => {
    expect(webFetchTarget("http://example.com/a?b=1#top").href).toBe(
      "https://example.com/a?b=1",
    );
  });

  it.each([
    ["not a url", "absolute"],
    ["ftp://example.com/", "Only http and https"],
    ["https://user:pw@example.com/", "credentials"],
    ["https://example.com:8443/", "port (443)"],
    ["https://127.0.0.1/", "IP addresses"],
    ["https://localhost/", "single-label"],
  ])("rejects %s", (url, message) => {
    expect(() => webFetchTarget(url)).toThrow(message);
  });
});

describe("htmlToText", () => {
  it("keeps the readable text, headings, list items and links", () => {
    const page = htmlToText(
      `<html><head><title>Hello &amp; welcome</title><style>p{}</style></head>
      <body><nav>menu</nav><h1>Heading</h1><p>Some <b>bold</b> text&nbsp;here.</p>
      <script>alert(1)</script><ul><li>one</li><li>two</li></ul>
      <a href="/docs">Docs</a><footer>footer</footer></body></html>`,
      new URL("https://example.com/start"),
    );
    expect(page.title).toBe("Hello & welcome");
    expect(page.text).toContain("# Heading");
    expect(page.text).toContain("Some bold text here.");
    expect(page.text).toContain("- one\n- two");
    expect(page.text).toContain("Docs (https://example.com/docs)");
    expect(page.text).not.toMatch(/menu|footer|alert/u);
  });

  it("decodes numeric and named entities", () => {
    expect(decodeEntities("&#65;&#x42;&lt;&unknown;")).toBe("AB<&unknown;");
  });
});

describe("fetchWebPage", () => {
  const unusedConnector: WebConnector = {
    connect: () => Promise.reject(new Error("should not connect")),
  };

  it("refuses everything when the project's network is off", async () => {
    await expect(
      fetchWebPage({
        url: "https://example.com/",
        policy: { preset: "off", allow: [] },
        connector: unusedConnector,
      }),
    ).rejects.toThrow("Network access is off");
  });

  it("validates the URL before connecting", async () => {
    await expect(
      fetchWebPage({
        url: "https://10.0.0.1/",
        policy: OPEN,
        connector: unusedConnector,
      }),
    ).rejects.toBeInstanceOf(WebFetchError);
  });
});

describe("directConnector", () => {
  const neverConnect = (): Socket => {
    throw new Error("should not connect");
  };

  it("applies the preset before resolving", async () => {
    const connector = directConnector({
      lookup: () => Promise.reject(new Error("should not resolve")),
      connect: neverConnect,
    });
    await expect(
      connector.connect({
        hostname: "example.com",
        port: 443,
        policy: DEPENDENCIES,
        signal,
      }),
    ).rejects.toThrow("Blocked example.com");
  });

  it("refuses hosts that resolve to private addresses", async () => {
    const connector = directConnector({
      lookup: async () => ["93.184.215.14", "192.168.1.10"],
      connect: neverConnect,
    });
    await expect(
      connector.connect({
        hostname: "rebind.example",
        port: 443,
        policy: OPEN,
        signal,
      }),
    ).rejects.toThrow("non-public address");
  });

  it("connects to the checked address", async () => {
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const connected: string[] = [];
    try {
      const connector = directConnector({
        lookup: async () => ["93.184.215.14"],
        connect: (address) => {
          connected.push(address);
          return net.connect({ host: "127.0.0.1", port });
        },
      });
      const socket = await connector.connect({
        hostname: "example.com",
        port: 443,
        policy: OPEN,
        signal,
      });
      socket.destroy();
      expect(connected).toEqual(["93.184.215.14"]);
    } finally {
      server.close();
    }
  });
});

describe("gatewayConnector", () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  async function fakeGateway(status: number) {
    const seen: { target?: string; authorization?: string } = {};
    const server = http.createServer();
    server.on("connect", (request, socket: Socket) => {
      seen.target = request.url;
      seen.authorization = request.headers["proxy-authorization"];
      socket.end(
        `HTTP/1.1 ${status} ${status === 200 ? "OK" : "Blocked"}\r\n\r\n`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    return { proxy: `http://127.0.0.1:${port}`, seen };
  }

  it("sends the policy's proxy authorization with CONNECT", async () => {
    const gateway = await fakeGateway(200);
    const connector = gatewayConnector({
      proxy: gateway.proxy,
      authorization: (policy) => `Basic ${policy.preset}`,
    });
    const socket = await connector.connect({
      hostname: "example.com",
      port: 443,
      policy: OPEN,
      signal,
    });
    socket.destroy();
    expect(gateway.seen).toEqual({
      target: "example.com:443",
      authorization: "Basic open",
    });
  });

  it("reports the gateway's refusal", async () => {
    const gateway = await fakeGateway(403);
    const connector = gatewayConnector({
      proxy: gateway.proxy,
      authorization: () => undefined,
    });
    await expect(
      connector.connect({
        hostname: "example.com",
        port: 443,
        policy: OPEN,
        signal,
      }),
    ).rejects.toThrow("Blocked");
    expect(gateway.seen.authorization).toBeUndefined();
  });
});
