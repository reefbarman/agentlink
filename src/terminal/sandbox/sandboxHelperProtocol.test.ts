import { describe, expect, it } from "vitest";

import {
  MAX_SANDBOX_HELPER_DATA_BYTES,
  SANDBOX_HELPER_PROTOCOL_VERSION,
  encodeSandboxHelperFrame,
  isSandboxHelperControlFrame,
  isSandboxHelperEventFrame,
  parseSandboxHelperEventLine,
  type SandboxHelperLaunchRequest,
} from "./sandboxHelperProtocol.js";

const identity = {
  channelId: "channel-1",
  commandId: "command-1",
  generation: 1,
} as const;

const launch: SandboxHelperLaunchRequest = {
  ...identity,
  version: SANDBOX_HELPER_PROTOCOL_VERSION,
  type: "launch",
  command: "npm test",
  cwd: "/workspace",
  shell: "/bin/zsh",
  environment: { HOME: "/private/tmp/home", TMPDIR: "/private/tmp/tmp" },
  filesystem: {
    denyRead: ["/Users/example"],
    allowRead: ["/workspace", "/usr"],
    allowWrite: ["/workspace", "/private/tmp"],
    denyWrite: ["/workspace/.git"],
  },
  network: { mode: "blocked" },
  protectedRoots: ["/workspace/.git/config"],
  structurallyProtectedRoots: ["/workspace/.git"],
  dimensions: { columns: 80, rows: 24 },
};

describe("sandbox helper control protocol", () => {
  it("accepts exact launch and interactive control frames", () => {
    expect(isSandboxHelperControlFrame(launch)).toBe(true);
    expect(
      isSandboxHelperControlFrame({
        ...identity,
        type: "input",
        data: "hello\r",
      }),
    ).toBe(true);
    expect(
      isSandboxHelperControlFrame({
        ...identity,
        type: "resize",
        dimensions: { columns: 120, rows: 40 },
      }),
    ).toBe(true);
    expect(
      isSandboxHelperControlFrame({ ...identity, type: "interrupt" }),
    ).toBe(true);
    expect(
      isSandboxHelperControlFrame({ ...identity, type: "terminate" }),
    ).toBe(true);
    expect(
      isSandboxHelperControlFrame({
        ...identity,
        type: "network-decision",
        requestId: "network-1",
        decision: "allow-once",
      }),
    ).toBe(true);
  });

  it("accepts public-only proxy policy and rejects other expansions", () => {
    expect(
      isSandboxHelperControlFrame({
        ...launch,
        network: { mode: "public-proxy" },
      }),
    ).toBe(true);
    expect(
      isSandboxHelperControlFrame({
        ...launch,
        network: {
          mode: "public-proxy",
          allowedPrivateTargets: ["127.0.0.1"],
        },
      }),
    ).toBe(false);
    expect(
      isSandboxHelperControlFrame({
        ...launch,
        network: { mode: "domain-proxy", allowedDomains: ["example.com"] },
      }),
    ).toBe(false);
  });

  it("rejects unknown fields, invalid identities, and oversized data", () => {
    expect(isSandboxHelperControlFrame({ ...launch, unexpected: true })).toBe(
      false,
    );
    const { structurallyProtectedRoots: _omitted, ...missingStructuralRoots } =
      launch;
    expect(isSandboxHelperControlFrame(missingStructuralRoots)).toBe(false);
    expect(isSandboxHelperControlFrame({ ...launch, generation: 0 })).toBe(
      false,
    );
    expect(
      isSandboxHelperControlFrame({
        ...identity,
        type: "input",
        data: "x".repeat(MAX_SANDBOX_HELPER_DATA_BYTES + 1),
      }),
    ).toBe(false);
    expect(
      isSandboxHelperControlFrame({
        ...identity,
        type: "resize",
        dimensions: { columns: 0, rows: 24 },
      }),
    ).toBe(false);
    expect(
      isSandboxHelperControlFrame({
        ...identity,
        type: "network-decision",
        requestId: "network-1",
        decision: "allow-always",
      }),
    ).toBe(false);
    expect(
      isSandboxHelperControlFrame({
        ...identity,
        type: "network-decision",
        requestId: "network-1",
        decision: "reject",
        address: "93.184.216.34",
      }),
    ).toBe(false);
  });

  it("encodes newline-delimited exact frames", () => {
    const encoded = encodeSandboxHelperFrame({
      ...identity,
      type: "input",
      data: "hello",
    });
    expect(encoded.endsWith("\n")).toBe(true);
    expect(JSON.parse(encoded)).toEqual({
      ...identity,
      type: "input",
      data: "hello",
    });
  });
});

describe("sandbox helper event protocol", () => {
  it("accepts lifecycle, stream, cwd, violation, and error events", () => {
    const events = [
      {
        ...identity,
        type: "ready",
        pid: 123,
        pgid: 123,
        backend: "seatbelt",
        backendVersion: "1",
      },
      { ...identity, type: "data", data: "output" },
      { ...identity, type: "cwd", cwd: "/workspace/subdir", nonce: "nonce" },
      {
        ...identity,
        type: "network-request",
        request: {
          requestId: "network-1",
          host: "registry.npmjs.org",
          protocol: "https",
          port: 443,
          address: "104.16.1.35",
          family: 4,
          dnsAnswers: [
            { address: "104.16.1.35", family: 4 },
            { address: "104.16.0.35", family: 4 },
          ],
          destinationClass: "public",
        },
      },
      {
        ...identity,
        type: "violation",
        violation: {
          operation: "network-connect",
          target: "127.0.0.1",
          reason: "private target denied",
          occurredAt: 100,
        },
      },
      { ...identity, type: "exit", exitCode: 0, timedOut: false },
      { ...identity, type: "error", message: "helper failed" },
    ];

    for (const event of events) {
      expect(isSandboxHelperEventFrame(event), event.type).toBe(true);
      expect(parseSandboxHelperEventLine(JSON.stringify(event))).toEqual(event);
    }
  });

  it("rejects mismatched process groups and incomplete identities", () => {
    expect(
      isSandboxHelperEventFrame({
        ...identity,
        type: "ready",
        pid: 123,
        pgid: 124,
        backend: "seatbelt",
      }),
    ).toBe(false);
    expect(
      isSandboxHelperEventFrame({
        channelId: identity.channelId,
        commandId: identity.commandId,
        type: "exit",
        exitCode: 0,
        timedOut: false,
      }),
    ).toBe(false);
  });

  it("rejects malformed, unknown, and oversized helper output", () => {
    expect(() => parseSandboxHelperEventLine("not json")).toThrow(
      "malformed JSON",
    );
    expect(() =>
      parseSandboxHelperEventLine(
        JSON.stringify({ ...identity, type: "ready", pid: 1 }),
      ),
    ).toThrow("invalid event frame");
    expect(() =>
      parseSandboxHelperEventLine(
        JSON.stringify({
          ...identity,
          type: "data",
          data: "x".repeat(MAX_SANDBOX_HELPER_DATA_BYTES + 1),
        }),
      ),
    ).toThrow("invalid event frame");
  });
});
