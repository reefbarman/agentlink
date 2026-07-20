import { BlockList, isIP } from "node:net";

import { lookup } from "node:dns/promises";

const FORBIDDEN_IPV4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["168.63.129.16", 32],
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
];

const FORBIDDEN_IPV6 = [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

const forbiddenAddresses = new BlockList();
for (const [address, prefix] of FORBIDDEN_IPV4) {
  forbiddenAddresses.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of FORBIDDEN_IPV6) {
  forbiddenAddresses.addSubnet(address, prefix, "ipv6");
}

function stripBrackets(host) {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function canonicalizeNetworkHost(host) {
  if (typeof host !== "string" || host.length === 0 || host.length > 255) {
    return undefined;
  }
  const bare = stripBrackets(host);
  if (bare.includes("%") || /[\0-\x20\x7f]/.test(bare)) {
    return undefined;
  }
  try {
    const bracketed = isIP(bare) === 6 ? `[${bare}]` : bare;
    return stripBrackets(new URL(`http://${bracketed}/`).hostname)
      .replace(/\.$/, "")
      .toLowerCase();
  } catch {
    return undefined;
  }
}

export function matchesAllowedDomain(host, pattern) {
  const canonicalHost = canonicalizeNetworkHost(host);
  const canonicalPattern = canonicalizeNetworkHost(
    pattern.startsWith("*.") ? pattern.slice(2) : pattern,
  );
  if (!canonicalHost || !canonicalPattern) {
    return false;
  }
  if (pattern.startsWith("*.")) {
    return (
      isIP(canonicalHost) === 0 &&
      canonicalHost.endsWith(`.${canonicalPattern}`)
    );
  }
  return canonicalHost === canonicalPattern;
}

function embeddedIpv4Address(address) {
  const match =
    /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address) ??
    /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!match) {
    return undefined;
  }
  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
}

export function isForbiddenNetworkAddress(address) {
  const canonical = canonicalizeNetworkHost(address);
  const family = canonical ? isIP(canonical) : 0;
  if (!family) {
    return true;
  }
  const embedded = family === 6 ? embeddedIpv4Address(canonical) : undefined;
  if (embedded) {
    return forbiddenAddresses.check(embedded, "ipv4");
  }
  return forbiddenAddresses.check(canonical, family === 6 ? "ipv6" : "ipv4");
}

export async function resolveApprovedDestination(
  host,
  allowedDomains,
  {
    lookupAll = (candidate) => lookup(candidate, { all: true, verbatim: true }),
  } = {},
) {
  const canonicalHost = canonicalizeNetworkHost(host);
  if (!canonicalHost) {
    throw new Error("destination host is malformed");
  }
  if (
    !allowedDomains.some((pattern) =>
      matchesAllowedDomain(canonicalHost, pattern),
    )
  ) {
    throw new Error("destination host is not allowlisted");
  }

  const family = isIP(canonicalHost);
  const answers = family
    ? [{ address: canonicalHost, family }]
    : await lookupAll(canonicalHost);
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new Error("destination host resolved to no addresses");
  }

  const resolved = answers.map((answer) => {
    const address = canonicalizeNetworkHost(answer.address);
    const answerFamily = address ? isIP(address) : 0;
    if (!address || !answerFamily || answerFamily !== Number(answer.family)) {
      throw new Error("destination host returned a malformed DNS answer");
    }
    return { address, family: answerFamily };
  });
  if (resolved.some((answer) => isForbiddenNetworkAddress(answer.address))) {
    throw new Error("destination host resolved to a forbidden address");
  }

  const approved = resolved[0];
  return {
    requestedHost: canonicalHost,
    address: approved.address,
    family: approved.family,
    answers: resolved,
  };
}
