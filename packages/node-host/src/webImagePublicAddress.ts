import * as dns from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * Address ranges that host-side web image retrieval must never connect to.
 * One classifier is shared by URL-literal checks and connection-time lookup,
 * so a hostname cannot resolve to an address that a literal URL could not use.
 *
 * IPv4 and IPv6 rules live in separate lists: Node's BlockList checks IPv4
 * addresses against IPv4-mapped IPv6 rules, so a shared list containing
 * `::ffff:0:0/96` would block every IPv4 address.
 */
const BLOCKED_IPV4 = new BlockList();
const BLOCKED_IPV6 = new BlockList();
populateBlockedAddresses();

function populateBlockedAddresses(): void {
  for (const [network, prefix] of [
    ["0.0.0.0", 8], // "this" network
    ["10.0.0.0", 8], // private
    ["100.64.0.0", 10], // carrier-grade NAT / shared
    ["127.0.0.0", 8], // loopback
    ["169.254.0.0", 16], // link-local, cloud metadata
    ["172.16.0.0", 12], // private
    ["192.0.0.0", 24], // IETF protocol assignments
    ["192.0.2.0", 24], // documentation
    ["192.88.99.0", 24], // 6to4 relay anycast
    ["192.168.0.0", 16], // private
    ["198.18.0.0", 15], // benchmarking
    ["198.51.100.0", 24], // documentation
    ["203.0.113.0", 24], // documentation
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reserved + broadcast
  ] as const) {
    BLOCKED_IPV4.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 128], // unspecified
    ["::1", 128], // loopback
    ["::", 96], // deprecated IPv4-compatible
    ["::ffff:0:0", 96], // IPv4-mapped
    ["64:ff9b::", 96], // NAT64
    ["64:ff9b:1::", 48], // local-use NAT64
    ["100::", 64], // discard
    ["2001::", 32], // Teredo
    ["2001:2::", 48], // benchmarking
    ["2001:10::", 28], // ORCHID
    ["2001:db8::", 32], // documentation
    ["2002::", 16], // 6to4
    ["fc00::", 7], // unique local
    ["fe80::", 10], // link-local
    ["fec0::", 10], // deprecated site-local
    ["ff00::", 8], // multicast
  ] as const) {
    BLOCKED_IPV6.addSubnet(network, prefix, "ipv6");
  }
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string, family?: number): boolean {
  const normalized = stripIpv6Brackets(address).toLowerCase();
  const detected = isIP(normalized);
  if (detected === 0) return false;
  if (family !== undefined && family !== detected) return false;
  return detected === 4
    ? !BLOCKED_IPV4.check(normalized, "ipv4")
    : !BLOCKED_IPV6.check(normalized, "ipv6");
}

/** Hostnames that must never be fetched regardless of DNS answers. */
export function isLocalHostname(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname).toLowerCase().replace(/\.$/u, "");
  return (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa") ||
    !host.includes(".") // single-label intranet names
  );
}

export class NonPublicDestinationError extends Error {
  readonly code = "EACCES";
  constructor() {
    super("web_image_destination_not_public");
    this.name = "NonPublicDestinationError";
  }
}

/**
 * Connection-time DNS lookup that rejects the whole answer set when any
 * address is non-public. Used as the dedicated undici Agent's
 * `connect.lookup`, so the validated address is the one actually dialed.
 */
export function createPublicOnlyLookup(
  resolveLookup: LookupFunction = dns.lookup,
): LookupFunction {
  return (hostname, options, callback) => {
    if (isLocalHostname(hostname)) {
      callback(new NonPublicDestinationError(), [], 0);
      return;
    }
    const literalFamily = isIP(stripIpv6Brackets(hostname));
    if (literalFamily) {
      // Literal IP hosts are rejected before transport; never dial them here.
      callback(new NonPublicDestinationError(), [], 0);
      return;
    }
    const requestedFamily =
      options.family === "IPv4"
        ? 4
        : options.family === "IPv6"
          ? 6
          : options.family;
    resolveLookup(
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
        const resolved = addresses as dns.LookupAddress[];
        if (
          resolved.length === 0 ||
          resolved.some(
            ({ address, family }) => !isPublicAddress(address, family),
          )
        ) {
          callback(new NonPublicDestinationError(), [], 0);
          return;
        }
        if (options.all) {
          callback(null, resolved);
          return;
        }
        const selected = resolved[0]!;
        callback(null, selected.address, selected.family);
      },
    );
  };
}
