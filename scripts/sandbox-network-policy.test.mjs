import {
  canonicalizeNetworkHost,
  isForbiddenNetworkAddress,
  matchesAllowedDomain,
  resolveApprovedDestination,
} from "./sandbox-network-policy.mjs";

import assert from "node:assert/strict";
import test from "node:test";

const FORBIDDEN_ADDRESSES = [
  "0.0.0.0",
  "10.0.0.1",
  "100.64.0.1",
  "127.0.0.1",
  "168.63.129.16",
  "169.254.169.254",
  "172.16.0.1",
  "192.0.0.1",
  "192.0.2.1",
  "192.168.0.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
  "::",
  "::1",
  "::ffff:127.0.0.1",
  "::ffff:169.254.169.254",
  "::127.0.0.1",
  "64:ff9b::127.0.0.1",
  "64:ff9b:1::1",
  "100::1",
  "2001::1",
  "2001:db8::1",
  "2002::1",
  "3fff::1",
  "5f00::1",
  "fc00::1",
  "fe80::1",
  "fec0::1",
  "ff00::1",
];

const PUBLIC_ADDRESSES = [
  "1.1.1.1",
  "8.8.8.8",
  "93.184.216.34",
  "2001:4860:4860::8888",
  "2606:4700:4700::1111",
  "::ffff:8.8.8.8",
];

test("canonicalizes URL-host spellings before policy checks", () => {
  assert.equal(canonicalizeNetworkHost("127.1"), "127.0.0.1");
  assert.equal(canonicalizeNetworkHost("0x7f.0.0.1"), "127.0.0.1");
  assert.equal(canonicalizeNetworkHost("EXAMPLE.COM."), "example.com");
  assert.equal(canonicalizeNetworkHost("[0:0:0:0:0:0:0:1]"), "::1");
  assert.equal(canonicalizeNetworkHost("fe80::1%lo0"), undefined);
  assert.equal(canonicalizeNetworkHost("evil.test\0.allowed.test"), undefined);
});

test("keeps exact and wildcard domain authority narrow", () => {
  assert.equal(
    matchesAllowedDomain("api.example.com", "api.example.com"),
    true,
  );
  assert.equal(
    matchesAllowedDomain("API.EXAMPLE.COM.", "api.example.com"),
    true,
  );
  assert.equal(matchesAllowedDomain("api.example.com", "*.example.com"), true);
  assert.equal(matchesAllowedDomain("example.com", "*.example.com"), false);
  assert.equal(matchesAllowedDomain("badexample.com", "*.example.com"), false);
  assert.equal(matchesAllowedDomain("127.0.0.1", "*.0.0.1"), false);
});

test("classifies private, local, metadata, translated, reserved, unspecified, and multicast ranges", () => {
  for (const address of FORBIDDEN_ADDRESSES) {
    assert.equal(isForbiddenNetworkAddress(address), true, address);
  }
  for (const address of PUBLIC_ADDRESSES) {
    assert.equal(isForbiddenNetworkAddress(address), false, address);
  }
});

test("denies explicit private literals even when allowlisted", async () => {
  for (const address of ["127.0.0.1", "169.254.169.254", "::1", "fc00::1"]) {
    await assert.rejects(
      resolveApprovedDestination(address, [address]),
      /forbidden address/,
      address,
    );
  }
});

test("rejects an allowlisted hostname when any DNS answer is forbidden", async () => {
  await assert.rejects(
    resolveApprovedDestination("mixed.example", ["mixed.example"], {
      lookupAll: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    }),
    /forbidden address/,
  );
});

test("returns only a validated numeric destination for dialing", async () => {
  const approved = await resolveApprovedDestination(
    "public.example",
    ["*.example"],
    {
      lookupAll: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ],
    },
  );
  assert.deepEqual(approved, {
    requestedHost: "public.example",
    address: "93.184.216.34",
    family: 4,
    answers: [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ],
  });
});

test("fails closed on malformed or empty DNS answers", async () => {
  await assert.rejects(
    resolveApprovedDestination("empty.example", ["empty.example"], {
      lookupAll: async () => [],
    }),
    /resolved to no addresses/,
  );
  await assert.rejects(
    resolveApprovedDestination("bad.example", ["bad.example"], {
      lookupAll: async () => [{ address: "not-an-ip", family: 4 }],
    }),
    /malformed DNS answer/,
  );
  await assert.rejects(
    resolveApprovedDestination("not-allowed.example", ["allowed.example"], {
      lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
    }),
    /not allowlisted/,
  );
});
