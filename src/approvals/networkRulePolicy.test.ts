import {
  canonicalNetworkDestinationKey,
  evaluateNetworkRulePolicy,
} from "./networkRulePolicy.js";
import { describe, expect, it } from "vitest";

describe("networkRulePolicy", () => {
  it("canonicalizes exact host, protocol, port, and IPv6 destinations", () => {
    expect(
      canonicalNetworkDestinationKey({
        protocol: "https",
        host: "Registry.NPMJS.Org",
        port: 443,
      }),
    ).toBe("https://registry.npmjs.org:443");
    expect(
      canonicalNetworkDestinationKey({
        protocol: "tcp",
        host: "[2606:4700:4700::1111]",
        port: 853,
      }),
    ).toBe("tcp://[2606:4700:4700::1111]:853");
  });

  it("rejects malformed destinations instead of producing permissive keys", () => {
    expect(() =>
      canonicalNetworkDestinationKey({
        protocol: "https",
        host: "",
        port: 443,
      }),
    ).toThrow("Invalid managed network destination");
    expect(() =>
      canonicalNetworkDestinationKey({
        protocol: "https",
        host: "example.com",
        port: 0,
      }),
    ).toThrow("Invalid managed network destination");
  });

  it("matches exact canonical rules and gives stricter decisions precedence", () => {
    const destination = {
      protocol: "https" as const,
      host: "registry.npmjs.org",
      port: 443,
    };
    expect(
      evaluateNetworkRulePolicy(
        {
          session: [
            {
              pattern: "https://registry.npmjs.org:443",
              mode: "exact",
              decision: "allow",
            },
          ],
          project: [
            {
              pattern: "https://registry.npmjs.org:443",
              mode: "exact",
              decision: "prompt",
            },
          ],
          global: [
            {
              pattern: "https://registry.npmjs.org:443",
              mode: "exact",
              decision: "forbidden",
            },
          ],
        },
        destination,
      ),
    ).toMatchObject({
      key: "https://registry.npmjs.org:443",
      decision: "forbidden",
      matches: [
        { scope: "session" },
        { scope: "project" },
        { scope: "global" },
      ],
    });
  });

  it("does not treat neighboring hosts, ports, or protocols as matches", () => {
    const rules = {
      session: [
        {
          pattern: "https://registry.npmjs.org:443",
          mode: "exact" as const,
          decision: "allow" as const,
        },
      ],
      project: [],
      global: [],
    };
    for (const destination of [
      { protocol: "http" as const, host: "registry.npmjs.org", port: 443 },
      { protocol: "https" as const, host: "registry.npmjs.org", port: 8443 },
      { protocol: "https" as const, host: "evilregistry.npmjs.org", port: 443 },
    ]) {
      expect(evaluateNetworkRulePolicy(rules, destination).decision).toBe(
        "unmatched",
      );
    }
  });
});
