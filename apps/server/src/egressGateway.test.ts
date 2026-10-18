import net, { type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  isPublicAddress,
  parseEgressAllowlist,
  startEgressGateway,
  type EgressGatewayOptions,
  type ResolvedAddress,
} from "./egressGateway.js";
import { runAssistantServerCli } from "./serverCli.js";

const PUBLIC_V4 = "93.184.216.34";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Echo server standing in for every upstream. */
async function echoServer(): Promise<number> {
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return (server.address() as net.AddressInfo).port;
}

async function gateway(
  allow: readonly string[],
  resolve: (hostname: string) => readonly ResolvedAddress[] = () => [
    { address: PUBLIC_V4, family: 4 },
  ],
  overrides: Partial<EgressGatewayOptions> = {},
) {
  const upstreamPort = await echoServer();
  const lookups: string[] = [];
  const connects: Array<[string, number]> = [];
  const logs: string[] = [];
  const started = await startEgressGateway({
    host: "127.0.0.1",
    port: 0,
    allow,
    lookup: async (hostname) => {
      lookups.push(hostname);
      return resolve(hostname);
    },
    // Every checked address is redirected to the local echo server.
    connect: (address, port) => {
      connects.push([address, port]);
      return net.connect({ host: "127.0.0.1", port: upstreamPort });
    },
    log: (line) => logs.push(line),
    ...overrides,
  });
  cleanup.push(() => started.close());
  return { port: started.port, lookups, connects, logs };
}

/** Send raw request bytes; resolve with the status line and the socket. */
async function send(
  port: number,
  request: string,
): Promise<{ status: string; body: string; socket: Socket }> {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.on("error", () => undefined);
  cleanup.push(() => void socket.destroy());
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(request);
  let received = "";
  await new Promise<void>((resolve) => {
    const onData = (chunk: Buffer) => {
      received += chunk.toString("utf8");
      const end = received.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = /content-length: (\d+)/iu.exec(received);
      if (length && received.length < end + 4 + Number(length[1])) return;
      socket.off("data", onData);
      resolve();
    };
    socket.on("data", onData);
    socket.once("close", () => resolve());
  });
  const [head = "", body = ""] = received.split("\r\n\r\n");
  return { status: head.split("\r\n")[0] ?? "", body, socket };
}

const connect = (port: number, target: string) =>
  send(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);

describe("egress gateway", () => {
  it("tunnels to an allowlisted name through the address it checked", async () => {
    const test = await gateway(["registry.example.org"]);
    const tunnel = await connect(test.port, "Registry.Example.ORG.:443");
    expect(tunnel.status).toBe("HTTP/1.1 200 Connection Established");
    const echoed = new Promise<string>((resolve) =>
      tunnel.socket.once("data", (chunk) => resolve(chunk.toString())),
    );
    tunnel.socket.write("hello through the tunnel");
    await expect(echoed).resolves.toBe("hello through the tunnel");
    expect(test.lookups).toEqual(["registry.example.org"]);
    expect(test.connects).toEqual([[PUBLIC_V4, 443]]);
    expect(test.logs).toContain(
      `egress: tunnel to registry.example.org:443 via ${PUBLIC_V4}`,
    );
  });

  it("refuses unlisted names before resolving them, naming the host", async () => {
    const test = await gateway(["registry.example.org"]);
    const refused = await connect(test.port, "evil.example.net:443");
    expect(refused.status).toBe(
      "HTTP/1.1 403 Blocked evil.example.net: not on the AgentLink egress allowlist",
    );
    expect(refused.body).toContain("evil.example.net");
    expect(test.lookups).toEqual([]);
    expect(test.connects).toEqual([]);
    expect(test.logs).toContain(
      "egress: blocked evil.example.net:443 (not on the allowlist)",
    );
  });

  it("matches wildcards on subdomains only", async () => {
    const test = await gateway(["*.cdn.example.org"]);
    expect((await connect(test.port, "a.b.cdn.example.org:443")).status).toBe(
      "HTTP/1.1 200 Connection Established",
    );
    for (const target of ["cdn.example.org:443", "xcdn.example.org:443"]) {
      expect((await connect(test.port, target)).status, target).toMatch(
        /^HTTP\/1\.1 403 /u,
      );
    }
  });

  it.each([
    ["a private IPv4 address", ["10.1.2.3"]],
    ["loopback", ["127.0.0.1"]],
    ["the cloud metadata address", ["169.254.169.254"]],
    ["carrier-grade NAT", ["100.64.0.1"]],
    ["IPv6 loopback", ["::1"]],
    ["an IPv4-mapped IPv6 address", ["::ffff:192.168.1.1"]],
    ["a unique-local IPv6 address", ["fd00::1"]],
    ["a public and a private address", [PUBLIC_V4, "192.168.50.1"]],
  ])(
    "refuses an allowlisted name that resolves to %s",
    async (_name, addresses) => {
      const test = await gateway(["registry.example.org"], () =>
        addresses.map((address) => ({
          address,
          family: net.isIP(address),
        })),
      );
      const refused = await connect(test.port, "registry.example.org:443");
      expect(refused.status).toBe(
        "HTTP/1.1 403 Blocked registry.example.org: it resolves to a non-public address",
      );
      expect(test.connects).toEqual([]);
    },
  );

  it.each([
    ["an IPv4 literal", `${PUBLIC_V4}:443`],
    ["an IPv6 literal", "[2606:4700::1111]:443"],
    ["another port", "registry.example.org:22"],
    ["a single-label container name", "meridian:3456"],
    ["localhost", "localhost:443"],
    ["a numeric last label", "registry.example.org.1:443"],
    ["no port", "registry.example.org"],
  ])("refuses %s without resolving it", async (_name, target) => {
    const test = await gateway(["registry.example.org"]);
    const refused = await connect(test.port, target);
    expect(refused.status).toMatch(/^HTTP\/1\.1 403 Blocked/u);
    expect(test.lookups).toEqual([]);
    expect(test.connects).toEqual([]);
  });

  it("refuses plain HTTP, naming the host", async () => {
    const test = await gateway(["registry.example.org"]);
    const refused = await send(
      test.port,
      "GET http://registry.example.org/pkg HTTP/1.1\r\nHost: registry.example.org\r\n\r\n",
    );
    expect(refused.status).toBe(
      "HTTP/1.1 403 Blocked: plain HTTP to registry.example.org is not allowed; use HTTPS",
    );
    expect(test.connects).toEqual([]);
  });

  it("reports names that do not resolve and upstreams that refuse", async () => {
    const unresolved = await gateway(["registry.example.org"], () => []);
    expect(
      (await connect(unresolved.port, "registry.example.org:443")).status,
    ).toBe(
      "HTTP/1.1 502 Bad gateway: registry.example.org could not be resolved",
    );

    // A port nothing listens on: grab one and release it.
    const closed = net.createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, "127.0.0.1", resolve),
    );
    const deadPort = (closed.address() as net.AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const refusing = await gateway(["registry.example.org"], undefined, {
      connect: () => net.connect({ host: "127.0.0.1", port: deadPort }),
    });
    expect(
      (await connect(refusing.port, "registry.example.org:443")).status,
    ).toBe(
      "HTTP/1.1 502 Bad gateway: could not connect to registry.example.org",
    );
  });

  it("connects over IPv4 only, so a NAT64 address cannot reach a private network", async () => {
    // A global-unicast IPv6 answer may be a network-specific NAT64 prefix
    // embedding 10.0.0.1; it is never dialled.
    const v6Only = await gateway(["registry.example.org"], () => [
      { address: "2001:470:1f0b:64::a00:1", family: 6 },
    ]);
    expect(
      (await connect(v6Only.port, "registry.example.org:443")).status,
    ).toBe(
      "HTTP/1.1 502 Bad gateway: registry.example.org has no IPv4 address",
    );
    expect(v6Only.connects).toEqual([]);

    const dual = await gateway(["registry.example.org"], () => [
      { address: "2606:4700::1111", family: 6 },
      { address: PUBLIC_V4, family: 4 },
    ]);
    expect((await connect(dual.port, "registry.example.org:443")).status).toBe(
      "HTTP/1.1 200 Connection Established",
    );
    expect(dual.connects).toEqual([[PUBLIC_V4, 443]]);
  });

  it("caps open connections and frees refused clients that never close", async () => {
    const test = await gateway(["registry.example.org"], undefined, {
      maxConnections: 1,
    });
    // A half-open client reads the 403 but never sends its FIN, so it
    // would hold its slot forever unless the gateway cuts it.
    const lingering = net.connect({
      host: "127.0.0.1",
      port: test.port,
      allowHalfOpen: true,
    });
    lingering.on("error", () => undefined);
    cleanup.push(() => void lingering.destroy());
    const refused = new Promise<string>((resolve) => {
      let text = "";
      lingering.on("data", (chunk) => (text += chunk.toString()));
      lingering.once("end", () => resolve(text.split("\r\n")[0]!));
    });
    lingering.once("connect", () =>
      lingering.write("CONNECT evil.example.net:443 HTTP/1.1\r\n\r\n"),
    );
    await expect(refused).resolves.toMatch(/^HTTP\/1\.1 403 /u);

    // While it lingers, the cap of one drops any new connection.
    const extra = net.connect({ host: "127.0.0.1", port: test.port });
    extra.on("error", () => undefined);
    cleanup.push(() => void extra.destroy());
    await expect(
      new Promise((resolve) => extra.once("close", () => resolve("dropped"))),
    ).resolves.toBe("dropped");

    // Once the linger expires its slot is free again.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect((await connect(test.port, "registry.example.org:443")).status).toBe(
      "HTTP/1.1 200 Connection Established",
    );
  }, 15_000);

  it("classifies public and non-public addresses", () => {
    for (const address of [PUBLIC_V4, "140.82.112.3", "2606:4700::1111"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "172.20.0.2",
      "192.168.50.160",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "fe80::1",
      "64:ff9b::a00:1",
      "2002:a00:1::1",
      "2001:db8::1",
      "not-an-address",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("validates allowlist entries", () => {
    const list = parseEgressAllowlist([" GitHub.com ", "*.example.org"]);
    expect(list.entries).toEqual(["github.com", "*.example.org"]);
    expect(list.matches("github.com")).toBe(true);
    expect(list.matches("api.github.com")).toBe(false);
    for (const entry of [
      "10.0.0.1",
      "localhost",
      "meridian",
      "*.com",
      "foo bar.com",
      "https://github.com",
      "*",
    ]) {
      expect(() => parseEgressAllowlist([entry]), entry).toThrow(
        "Egress allowlist entry must be a host name",
      );
    }
  });

  it("runs from the command line with extra hosts from flags and the environment", async () => {
    const logs: string[] = [];
    let stop!: (signal: string) => void;
    const running = runAssistantServerCli(
      [
        "egress-gateway",
        "--listen",
        "127.0.0.1:0",
        "--no-default-allow",
        "--allow",
        "a.example.org",
      ],
      {
        stdout: () => undefined,
        log: (line) => logs.push(line),
        env: { AGENTLINK_EGRESS_ALLOW: "b.example.org, *.c.example.org" },
        waitForShutdown: () =>
          new Promise<string>((resolve) => {
            stop = resolve;
          }),
      },
    );
    await expect
      .poll(() => logs.find((line) => line.includes("listening on")))
      .toMatch(
        /^AgentLink egress gateway listening on 127\.0\.0\.1:\d+; allowing a\.example\.org, b\.example\.org, \*\.c\.example\.org$/u,
      );
    stop("SIGTERM");
    await expect(running).resolves.toBe(0);

    const io = {
      stdout: () => undefined,
      log: (line: string) => logs.push(line),
      env: {},
      waitForShutdown: async () => "SIGTERM",
    };
    await expect(
      runAssistantServerCli(["egress-gateway", "--allow", "10.0.0.1"], io),
    ).resolves.toBe(2);
    await expect(
      runAssistantServerCli(["egress-gateway", "--no-default-allow"], io),
    ).resolves.toBe(2);
    expect(logs.join("\n")).toContain("the allowlist is empty");
  });
});
