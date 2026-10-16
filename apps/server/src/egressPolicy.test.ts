import net, { type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { parseEgressAllowlist, startEgressGateway } from "./egressGateway.js";
import {
  egressPolicyAuthorizer,
  egressProxyUrl,
  networkPolicyAllows,
  normalizeNetworkAllow,
  parseNetworkPolicyKey,
  proxyAuthorizationHeader,
  signNetworkPolicy,
  verifyNetworkPolicyHeader,
  type NetworkPolicy,
} from "./egressPolicy.js";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const DEPENDENCIES = parseEgressAllowlist(["registry.npmjs.org", "github.com"]);

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const basic = (username: string, password: string) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

describe("network policies", () => {
  it("allows by preset: open web, dependencies plus extra sites, or nothing", () => {
    const open: NetworkPolicy = { preset: "open", allow: [] };
    const deps: NetworkPolicy = {
      preset: "dependencies",
      allow: ["docs.example.com", "*.example.org"],
    };
    const off: NetworkPolicy = { preset: "off", allow: ["docs.example.com"] };
    expect(networkPolicyAllows(open, "news.example.net", DEPENDENCIES)).toEqual(
      { allowed: true },
    );
    for (const host of [
      "registry.npmjs.org",
      "docs.example.com",
      "api.example.org",
    ]) {
      expect(networkPolicyAllows(deps, host, DEPENDENCIES).allowed, host).toBe(
        true,
      );
    }
    expect(
      networkPolicyAllows(deps, "news.example.net", DEPENDENCIES),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining("add") });
    expect(networkPolicyAllows(off, "docs.example.com", DEPENDENCIES)).toEqual({
      allowed: false,
      reason: "network access is off for this project",
    });
    // IP literals and single labels are never names a policy can allow.
    expect(networkPolicyAllows(open, "192.168.1.10").allowed).toBe(false);
    expect(networkPolicyAllows(open, "router").allowed).toBe(false);
  });

  it("validates extra sites like the gateway allowlist", () => {
    expect(
      normalizeNetworkAllow([" Docs.Example.com ", "", "*.x.org"]),
    ).toEqual(["docs.example.com", "*.x.org"]);
    expect(() => normalizeNetworkAllow(["10.0.0.1"])).toThrow("10.0.0.1");
    expect(() =>
      normalizeNetworkAllow(
        Array.from({ length: 101 }, (_, i) => `h${i}.example.com`),
      ),
    ).toThrow("at most 100");
  });

  it("round-trips a signed policy and refuses forged or foreign credentials", () => {
    const policy: NetworkPolicy = {
      preset: "dependencies",
      allow: ["docs.example.com"],
    };
    const { username, password } = signNetworkPolicy(KEY, policy);
    expect(verifyNetworkPolicyHeader(KEY, basic(username, password))).toEqual(
      policy,
    );
    expect(verifyNetworkPolicyHeader(KEY, undefined)).toBeUndefined();
    // Signed with another key, or the policy swapped for a looser one.
    expect(
      verifyNetworkPolicyHeader(
        KEY,
        basic(username, signNetworkPolicy(OTHER_KEY, policy).password),
      ),
    ).toBe("invalid");
    const looser = signNetworkPolicy(KEY, { preset: "open", allow: [] });
    expect(
      verifyNetworkPolicyHeader(KEY, basic(looser.username, password)),
    ).toBe("invalid");
    for (const header of ["Bearer x", "Basic !!", basic("user", "pass")]) {
      expect(verifyNetworkPolicyHeader(KEY, header), header).toBe("invalid");
    }
  });

  it("puts the signed policy in the proxy URL a command gets", () => {
    const url = egressProxyUrl("http://egress-gateway:3128", KEY, {
      preset: "off",
      allow: [],
    });
    const parsed = new URL(url);
    expect(parsed.host).toBe("egress-gateway:3128");
    expect(
      verifyNetworkPolicyHeader(KEY, basic(parsed.username, parsed.password)),
    ).toEqual({ preset: "off", allow: [] });
    expect(
      egressProxyUrl("http://egress-gateway:3128", undefined, {
        preset: "off",
        allow: [],
      }),
    ).toBe("http://egress-gateway:3128");
  });

  it("needs a policy key of at least 32 bytes", () => {
    expect(parseNetworkPolicyKey(`${"ab".repeat(32)}\n`)).toHaveLength(32);
    expect(() => parseNetworkPolicyKey("abcd")).toThrow("at least 32 bytes");
  });
});

describe("egress gateway with per-project policies", () => {
  async function echoServer(): Promise<number> {
    const sockets = new Set<Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.pipe(socket);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    );
    return (server.address() as net.AddressInfo).port;
  }

  async function connect(
    port: number,
    target: string,
    authorization?: string,
  ): Promise<string> {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.on("error", () => undefined);
    cleanup.push(() => void socket.destroy());
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ""}\r\n`,
    );
    let received = "";
    await new Promise<void>((resolve) => {
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        if (received.includes("\r\n")) resolve();
      });
      socket.once("close", () => resolve());
    });
    return received.split("\r\n")[0] ?? "";
  }

  it("follows the signed policy, keeps its own list without one, and refuses bad credentials", async () => {
    const upstream = await echoServer();
    const resolved: Record<string, string> = {
      "news.example.net": "93.184.216.34",
      "registry.npmjs.org": "93.184.216.35",
      // A public-looking name that points into the LAN.
      "intranet.example.net": "192.168.1.10",
    };
    const gateway = await startEgressGateway({
      host: "127.0.0.1",
      port: 0,
      allow: DEPENDENCIES.entries,
      lookup: async (hostname) => [
        { address: resolved[hostname] ?? "93.184.216.36", family: 4 },
      ],
      connect: () => net.connect({ host: "127.0.0.1", port: upstream }),
      authorize: egressPolicyAuthorizer(KEY, DEPENDENCIES),
    });
    cleanup.push(() => gateway.close());
    const as = (policy: NetworkPolicy) => proxyAuthorizationHeader(KEY, policy);
    const open = as({ preset: "open", allow: [] });

    expect(await connect(gateway.port, "news.example.net:443", open)).toBe(
      "HTTP/1.1 200 Connection Established",
    );
    // Open web still never reaches private addresses.
    expect(
      await connect(gateway.port, "intranet.example.net:443", open),
    ).toContain("403 Blocked intranet.example.net");
    expect(
      await connect(
        gateway.port,
        "news.example.net:443",
        as({ preset: "off", allow: [] }),
      ),
    ).toBe(
      "HTTP/1.1 403 Blocked news.example.net: network access is off for this project",
    );
    expect(
      await connect(
        gateway.port,
        "registry.npmjs.org:443",
        as({ preset: "dependencies", allow: [] }),
      ),
    ).toBe("HTTP/1.1 200 Connection Established");
    // No credentials: the gateway's own list, as before.
    expect(await connect(gateway.port, "registry.npmjs.org:443")).toBe(
      "HTTP/1.1 200 Connection Established",
    );
    // Challenged, so a browser that only answers a challenge can retry.
    expect(await connect(gateway.port, "news.example.net:443")).toBe(
      "HTTP/1.1 407 Blocked news.example.net: not on the AgentLink egress allowlist",
    );
    // Open web never reaches an address literal either.
    expect(await connect(gateway.port, "192.168.50.221:443", open)).toMatch(
      /^HTTP\/1\.1 403 Blocked/u,
    );
    expect(
      await connect(
        gateway.port,
        "news.example.net:443",
        proxyAuthorizationHeader(OTHER_KEY, { preset: "open", allow: [] }),
      ),
    ).toBe(
      "HTTP/1.1 407 Blocked news.example.net: the proxy credentials are not valid",
    );
  });
});
