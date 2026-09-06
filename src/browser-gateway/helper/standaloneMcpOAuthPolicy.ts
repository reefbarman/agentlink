import { BlockList, isIP, type LookupFunction } from "node:net";

import * as dns from "node:dns";
import { Agent, type Dispatcher } from "undici";

const BLOCKED_ADDRESSES = createBlockedAddresses();

export interface StandaloneMcpOAuthAddressResolver {
  (hostname: string): Promise<readonly string[]>;
}

export interface StandaloneMcpOAuthPinnedFetch {
  fetch(
    baseFetch: typeof globalThis.fetch,
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ): Promise<Response>;
  dispose(): Promise<void>;
}

/** Attach a public-address-only lookup to the actual OAuth HTTP socket. */
export function createStandaloneMcpOAuthPinnedFetch(): StandaloneMcpOAuthPinnedFetch {
  const dispatcher = new Agent({ connect: { lookup: publicOnlyLookup } });
  return {
    async fetch(baseFetch, input, init) {
      return await baseFetch(input, {
        ...init,
        dispatcher,
      } as RequestInit & { dispatcher: Dispatcher });
    },
    async dispose() {
      await dispatcher.close();
    },
  };
}

/** Resolve and reject local, private, metadata, reserved, and non-HTTPS OAuth targets. */
export async function isSafeStandaloneMcpOAuthDestination(
  url: URL,
  resolveAddresses: StandaloneMcpOAuthAddressResolver = resolveHostAddresses,
): Promise<boolean> {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    return false;
  }

  const literalFamily = isIP(hostname);
  if (literalFamily) return isPublicAddress(hostname, literalFamily);

  let addresses: readonly string[];
  try {
    addresses = await resolveAddresses(hostname);
  } catch {
    return false;
  }
  return (
    addresses.length > 0 &&
    addresses.every((address) => {
      const normalized = stripIpv6Brackets(address);
      const family = isIP(normalized);
      return family !== 0 && isPublicAddress(normalized, family);
    })
  );
}

async function resolveHostAddresses(
  hostname: string,
): Promise<readonly string[]> {
  const answers = await dns.promises.lookup(hostname, {
    all: true,
    verbatim: true,
  });
  return answers.map((answer) => answer.address);
}

const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  const requestedFamily =
    options.family === "IPv4"
      ? 4
      : options.family === "IPv6"
        ? 6
        : options.family;
  dns.lookup(
    hostname,
    {
      all: true,
      verbatim: true,
      family: requestedFamily,
      hints: options.hints,
    },
    (error, addresses) => {
      if (error) {
        callback(error, [], 0);
        return;
      }
      if (
        addresses.length === 0 ||
        addresses.some(
          ({ address, family }) => !isPublicAddress(address, family),
        )
      ) {
        const blocked = new Error(
          "standalone_mcp_oauth_destination_not_public",
        ) as NodeJS.ErrnoException;
        blocked.code = "EACCES";
        callback(blocked, [], 0);
        return;
      }
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const selected = addresses[0]!;
      callback(null, selected.address, selected.family);
    },
  );
};

function isPublicAddress(address: string, family: number): boolean {
  return !BLOCKED_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
}

function createBlockedAddresses(): BlockList {
  const blockList = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    blockList.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["100::", 64],
    ["2001::", 32],
    ["2001:2::", 48],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    blockList.addSubnet(network, prefix, "ipv6");
  }
  return blockList;
}
