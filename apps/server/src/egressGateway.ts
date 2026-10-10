import { promises as dns } from "node:dns";
import http from "node:http";
import net, { BlockList, type Socket } from "node:net";

/**
 * Outbound gateway for commands on the command worker. The worker has no
 * route to the internet; its commands get `HTTPS_PROXY` pointing here, and
 * this proxy opens only HTTPS tunnels (CONNECT) to allowlisted host names.
 *
 * Every tunnel is checked by name before anything is resolved, then every
 * address the name resolves to must be public, and the tunnel connects to
 * the address that was checked (no second lookup to rebind). A redirect to
 * another host is a new CONNECT and is checked again. Plain HTTP, IP
 * literals, other ports, and unlisted names are refused with a 403 that
 * names the host, so the owner can add it if it is wanted.
 */
export interface EgressGatewayOptions {
  readonly host: string;
  readonly port: number;
  /** Host names (`registry.npmjs.org`) or subdomain wildcards (`*.example.com`). */
  readonly allow: readonly string[];
  /** Destination ports tunnels may use. Defaults to 443 only. */
  readonly ports?: readonly number[];
  readonly lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly connect?: (address: string, port: number) => Socket;
  readonly connectTimeoutMs?: number;
  /** A tunnel with no traffic either way for this long is closed. */
  readonly idleTimeoutMs?: number;
  readonly maxTunnels?: number;
  /** Open client connections of any kind, including refused ones. */
  readonly maxConnections?: number;
  readonly log?: (line: string) => void;
  /**
   * Decides each tunnel by host name in place of `allow`, for example from
   * a signed per-project policy in the proxy credentials. Address checks
   * (public addresses only) still apply to everything it allows.
   */
  readonly authorize?: (request: {
    readonly hostname: string;
    readonly proxyAuthorization: string | undefined;
  }) => EgressAuthorization;
}

export type EgressAuthorization =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** 407 asks for (valid) credentials; 403 refuses. */
      readonly status: 403 | 407;
      readonly reason: string;
    };

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

export interface EgressGateway {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Package registries and source hosts a coding workload commonly needs:
 * npm, GitHub (clones, archives, release downloads used by postinstall
 * scripts), PyPI, and Node.js headers for native addons.
 */
export const DEFAULT_EGRESS_ALLOWLIST: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "raw.githubusercontent.com",
  "pypi.org",
  "files.pythonhosted.org",
  "nodejs.org",
];

const DEFAULT_PORTS = [443];
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_TUNNELS = 256;
const DEFAULT_MAX_CONNECTIONS = 512;
/** How long a refused client gets to read the response before it is cut. */
const REFUSAL_LINGER_MS = 2_000;
const MAX_HOSTNAME_LENGTH = 253;
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export interface EgressAllowlist {
  readonly entries: readonly string[];
  matches(hostname: string): boolean;
}

/**
 * Validate allowlist entries. Each is a fully qualified host name with at
 * least two labels, or `*.` and such a name for its subdomains (not the
 * name itself). IP addresses and single-label names are refused: they would
 * point at the LAN or at sibling containers.
 */
export function parseEgressAllowlist(
  entries: readonly string[],
): EgressAllowlist {
  const exact = new Set<string>();
  const suffixes = new Set<string>();
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    const wildcard = entry.startsWith("*.");
    const name = normalizeHostname(wildcard ? entry.slice(2) : entry);
    if (!name) {
      throw new Error(
        `Egress allowlist entry must be a host name like registry.npmjs.org or *.example.com: ${raw}`,
      );
    }
    (wildcard ? suffixes : exact).add(name);
  }
  return {
    entries: [...exact, ...[...suffixes].map((suffix) => `*.${suffix}`)],
    matches(hostname) {
      if (exact.has(hostname)) return true;
      for (const suffix of suffixes) {
        if (hostname.endsWith(`.${suffix}`)) return true;
      }
      return false;
    },
  };
}

/** Lowercased host name without a trailing dot, or undefined if invalid. */
export function normalizeHostname(raw: string): string | undefined {
  const name = raw.toLowerCase().replace(/\.$/u, "");
  if (!name || name.length > MAX_HOSTNAME_LENGTH || net.isIP(name)) {
    return undefined;
  }
  const labels = name.split(".");
  if (
    labels.length < 2 ||
    !labels.every((label) => LABEL_PATTERN.test(label))
  ) {
    return undefined;
  }
  // An all-numeric last label is an IPv4 address in another spelling.
  if (/^[0-9]+$/u.test(labels.at(-1)!)) return undefined;
  return name;
}

const NON_PUBLIC_V4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC_V4.addSubnet(network, prefix, "ipv4");
}
const GLOBAL_UNICAST_V6 = new BlockList();
GLOBAL_UNICAST_V6.addSubnet("2000::", 3, "ipv6");
const NON_PUBLIC_V6 = new BlockList();
for (const [network, prefix] of [
  // Teredo and 6to4 embed IPv4 addresses that may be private.
  ["2001::", 32],
  ["2002::", 16],
  ["2001:db8::", 32],
  ["2001:10::", 28],
  ["2001:20::", 28],
] as const) {
  NON_PUBLIC_V6.addSubnet(network, prefix, "ipv6");
}

/**
 * Whether an address is publicly routable. IPv6 must be global unicast
 * (2000::/3), which also excludes IPv4-mapped, NAT64, unique-local, and
 * link-local addresses whatever IPv4 address they carry.
 */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !NON_PUBLIC_V4.check(address, "ipv4");
  if (family === 6) {
    return (
      GLOBAL_UNICAST_V6.check(address, "ipv6") &&
      !NON_PUBLIC_V6.check(address, "ipv6")
    );
  }
  return false;
}

type ConnectTarget =
  | { readonly ok: true; readonly hostname: string; readonly port: number }
  | { readonly ok: false; readonly reason: string; readonly shown?: string };

function parseConnectTarget(authority: string): ConnectTarget {
  if (authority.startsWith("[")) {
    return { ok: false, reason: "IP addresses are not allowed" };
  }
  const separator = authority.lastIndexOf(":");
  const rawPort = separator > 0 ? authority.slice(separator + 1) : "";
  const port = /^[0-9]{1,5}$/u.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: "the target must be host:port" };
  }
  const rawHost = authority.slice(0, separator);
  if (net.isIP(rawHost)) {
    return {
      ok: false,
      reason: "IP addresses are not allowed",
      shown: rawHost,
    };
  }
  const hostname = normalizeHostname(rawHost);
  if (!hostname) return { ok: false, reason: "the host name is invalid" };
  return { ok: true, hostname, port };
}

/**
 * Tunnels use IPv4 only: an IPv6 answer could be a NAT64 address under a
 * network-specific prefix that maps to a private IPv4 address, which no
 * fixed prefix list can recognise. Container networks here are IPv4 anyway.
 */
async function defaultLookup(
  hostname: string,
): Promise<readonly ResolvedAddress[]> {
  return await dns.lookup(hostname, { all: true, family: 4 });
}

export async function startEgressGateway(
  options: EgressGatewayOptions,
): Promise<EgressGateway> {
  const allowlist = parseEgressAllowlist(options.allow);
  const ports = new Set(options.ports ?? DEFAULT_PORTS);
  const lookup = options.lookup ?? defaultLookup;
  const connect =
    options.connect ??
    ((address: string, port: number) => net.connect({ host: address, port }));
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxTunnels = options.maxTunnels ?? DEFAULT_MAX_TUNNELS;
  const log = options.log ?? (() => undefined);
  const tunnels = new Set<Socket>();

  const server = http.createServer();
  server.headersTimeout = connectTimeoutMs;
  server.requestTimeout = connectTimeoutMs;
  // Counts every socket until it closes, tunnels included.
  server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;

  // Plain HTTP (absolute-form requests) and anything that is not a proxy
  // request: nothing is fetched on a command's behalf without TLS.
  server.on("request", (request, response) => {
    let shown: string | undefined;
    try {
      shown = normalizeHostname(new URL(request.url ?? "").hostname);
    } catch {
      shown = undefined;
    }
    const message = shown
      ? `Blocked: plain HTTP to ${shown} is not allowed; use HTTPS`
      : "Blocked: this is an HTTPS-only egress proxy";
    log(`egress: blocked ${shown ?? "a request"} (plain HTTP)`);
    response.writeHead(403, message, {
      "content-type": "text/plain; charset=utf-8",
      "x-agentlink-egress": "blocked",
      connection: "close",
    });
    response.end(`${message}\n`);
  });

  server.on("connect", (request, client: Socket, head: Buffer) => {
    client.on("error", () => undefined);
    const header = request.headers["proxy-authorization"];
    void openTunnel(
      request.url ?? "",
      client,
      head,
      Array.isArray(header) ? header[0] : header,
    );
  });

  async function openTunnel(
    authority: string,
    client: Socket,
    head: Buffer,
    proxyAuthorization: string | undefined,
  ): Promise<void> {
    const target = parseConnectTarget(authority);
    if (!target.ok) {
      const shown = target.shown ? ` ${target.shown}` : "";
      refuse(client, 403, `Blocked${shown}: ${target.reason}`);
      log(`egress: blocked${shown || " a tunnel"} (${target.reason})`);
      return;
    }
    const { hostname, port } = target;
    const label = `${hostname}:${port}`;
    if (!ports.has(port)) {
      refuse(client, 403, `Blocked ${label}: only port 443 is allowed`);
      log(`egress: blocked ${label} (port not allowed)`);
      return;
    }
    if (options.authorize) {
      const decision = options.authorize({ hostname, proxyAuthorization });
      if (!decision.allowed) {
        refuse(
          client,
          decision.status,
          `Blocked ${hostname}: ${decision.reason}`,
          decision.status === 407
            ? ['Proxy-Authenticate: Basic realm="agentlink-egress"']
            : [],
        );
        log(`egress: blocked ${label} (${decision.reason})`);
        return;
      }
    } else if (!allowlist.matches(hostname)) {
      refuse(
        client,
        403,
        `Blocked ${hostname}: not on the AgentLink egress allowlist`,
      );
      log(`egress: blocked ${label} (not on the allowlist)`);
      return;
    }
    if (tunnels.size >= maxTunnels) {
      refuse(client, 503, `Busy: too many open tunnels`);
      log(`egress: refused ${label} (too many tunnels)`);
      return;
    }
    tunnels.add(client);
    client.once("close", () => tunnels.delete(client));

    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await withTimeout(lookup(hostname), connectTimeoutMs);
    } catch {
      addresses = [];
    }
    if (client.destroyed) return;
    if (addresses.length === 0) {
      refuse(client, 502, `Bad gateway: ${hostname} could not be resolved`);
      log(`egress: failed ${label} (no address)`);
      return;
    }
    // Every answer must be public, even ones that will not be used.
    const private_ = addresses.find((entry) => !isPublicAddress(entry.address));
    if (private_) {
      refuse(
        client,
        403,
        `Blocked ${hostname}: it resolves to a non-public address`,
      );
      log(
        `egress: blocked ${label} (resolves to non-public ${private_.address})`,
      );
      return;
    }

    const address = addresses.find((entry) =>
      net.isIPv4(entry.address),
    )?.address;
    if (!address) {
      refuse(client, 502, `Bad gateway: ${hostname} has no IPv4 address`);
      log(`egress: failed ${label} (no IPv4 address)`);
      return;
    }
    const upstream = connect(address, port);
    let state: "connecting" | "established" | "failed" = "connecting";
    const fail = (status: number, message: string, reason: string) => {
      if (state !== "connecting") return;
      state = "failed";
      clearTimeout(timer);
      upstream.destroy();
      refuse(client, status, message);
      log(`egress: failed ${label} (${reason})`);
    };
    const timer = setTimeout(
      () => fail(504, `Gateway timeout: ${hostname} did not answer`, "timeout"),
      connectTimeoutMs,
    );
    timer.unref();
    upstream.once("connect", () => {
      if (state !== "connecting") return;
      clearTimeout(timer);
      if (client.destroyed) {
        state = "failed";
        upstream.destroy();
        return;
      }
      state = "established";
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
      for (const socket of [client, upstream]) {
        socket.setTimeout(idleTimeoutMs, () => {
          client.destroy();
          upstream.destroy();
        });
      }
      log(`egress: tunnel to ${label} via ${address}`);
    });
    upstream.on("error", () => {
      if (state === "established") client.destroy();
      else {
        fail(
          502,
          `Bad gateway: could not connect to ${hostname}`,
          "connect error",
        );
      }
    });
    upstream.once("close", () => {
      if (state === "established") client.destroy();
    });
    client.once("close", () => upstream.destroy());
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  let closing: Promise<void> | undefined;
  return {
    port,
    close() {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
        server.closeAllConnections();
        for (const socket of tunnels) socket.destroy();
        await closed;
      })();
      return closing;
    },
  };
}

/**
 * Answer a CONNECT with an error and close. The reason phrase repeats the
 * message because many clients show only the status line. The socket is
 * destroyed shortly after, so a client that never closes its side cannot
 * hold it open.
 */
function refuse(
  client: Socket,
  status: number,
  message: string,
  extraHeaders: readonly string[] = [],
): void {
  if (client.destroyed) return;
  const body = `${message}\n`;
  setTimeout(() => client.destroy(), REFUSAL_LINGER_MS).unref();
  client.end(
    [
      `HTTP/1.1 ${status} ${message}`,
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "X-AgentLink-Egress: blocked",
      ...extraHeaders,
      "Connection: close",
      "",
      body,
    ].join("\r\n"),
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
