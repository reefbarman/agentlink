import {
  MCP_PROTOCOL_VERDICT_TTL_MS,
  MCP_STDIO_PROBE_TIMEOUT_MS,
  isMcpProbeRejection,
  mcpProtocolVerdictKey,
  normalizeMcpProtocolSetting,
  parseMcpProtocolVerdict,
  resolveMcpProtocolPlan,
} from "./mcpProtocolNegotiation.js";
import {
  SdkError,
  SdkErrorCode,
  SdkHttpError,
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import type { McpServerConfig } from "./mcpConfig.js";

const stdio: McpServerConfig = { name: "local", command: "node", args: ["a"] };
const http: McpServerConfig = {
  name: "remote",
  type: "http",
  url: "https://example.test/mcp",
};
const discover = {
  supportedVersions: ["2026-07-28"],
  capabilities: { tools: { listChanged: true } },
};
const now = 10 * MCP_PROTOCOL_VERDICT_TTL_MS;
const plan = (
  cfg: McpServerConfig,
  verdict?: unknown,
  interactiveAuth = false,
) => resolveMcpProtocolPlan(cfg, verdict, { now, interactiveAuth });

describe("MCP protocol negotiation plan", () => {
  it("probes automatically by default, with a bounded stdio probe", () => {
    expect(plan(stdio)).toEqual({
      setting: "auto",
      negotiation: {
        mode: "auto",
        probe: { timeoutMs: MCP_STDIO_PROBE_TIMEOUT_MS },
      },
      verdictKey: mcpProtocolVerdictKey(stdio),
    });
    expect(plan(http).negotiation).toEqual({ mode: "auto" });
  });

  it("reuses a fresh remembered verdict instead of probing", () => {
    expect(plan(http, { kind: "legacy", checkedAt: now - 1 }).prior).toEqual({
      kind: "legacy",
    });
    expect(
      plan(http, { kind: "modern", discover, checkedAt: now - 1 }).prior,
    ).toEqual({ kind: "modern", discover });
  });

  it("probes again once a verdict is older than the horizon", () => {
    const stale = now - MCP_PROTOCOL_VERDICT_TTL_MS - 1;
    expect(plan(http, { kind: "legacy", checkedAt: stale }).prior).toBe(
      undefined,
    );
  });

  it("probes instead of reusing a modern verdict during browser sign-in", () => {
    const verdict = { kind: "modern", discover, checkedAt: now - 1 };
    expect(plan(http, verdict, true).prior).toBe(undefined);
    expect(
      plan(http, { kind: "legacy", checkedAt: now - 1 }, true).prior,
    ).toEqual({ kind: "legacy" });
  });

  it("ignores malformed stored verdicts", () => {
    for (const value of [
      null,
      "modern",
      { kind: "modern", checkedAt: now },
      { kind: "modern", discover: { capabilities: {} }, checkedAt: now },
      { kind: "legacy" },
      { kind: "other", checkedAt: now },
    ]) {
      expect(parseMcpProtocolVerdict(value)).toBe(undefined);
      expect(plan(http, value).prior).toBe(undefined);
    }
  });

  it("honours explicit per-server settings without the cache", () => {
    const verdict = { kind: "modern", discover, checkedAt: now };
    expect(plan({ ...http, protocol: "legacy" }, verdict)).toEqual({
      setting: "legacy",
      negotiation: { mode: "legacy" },
    });
    expect(plan({ ...stdio, protocol: "2026-07-28" }, verdict)).toEqual({
      setting: "2026-07-28",
      negotiation: { mode: { pin: "2026-07-28" } },
    });
  });

  it("does not probe a sign-in proxy unless the server is pinned", () => {
    const proxy = { ...stdio, command: "npx", args: ["mcp-remote", "x"] };
    expect(
      resolveMcpProtocolPlan(proxy, undefined, {
        now,
        interactiveAuth: false,
        authProxy: true,
      }),
    ).toEqual({ setting: "auto", negotiation: { mode: "legacy" } });
    expect(
      resolveMcpProtocolPlan({ ...proxy, protocol: "2026-07-28" }, undefined, {
        now,
        interactiveAuth: false,
        authProxy: true,
      }).negotiation,
    ).toEqual({ mode: { pin: "2026-07-28" } });
  });

  it("recognizes a server rejecting the probe, not a network outage", () => {
    expect(
      isMcpProbeRejection(
        new SdkHttpError(SdkErrorCode.EraNegotiationFailed, "HTTP 500", {
          status: 500,
        }),
      ),
    ).toBe(true);
    expect(
      isMcpProbeRejection(
        new SdkError(
          SdkErrorCode.EraNegotiationFailed,
          "Version negotiation probe failed: the server answered with an unusable reply (x)",
        ),
      ),
    ).toBe(true);
    expect(
      isMcpProbeRejection(
        new SdkError(
          SdkErrorCode.EraNegotiationFailed,
          "Version negotiation probe failed: fetch failed",
        ),
      ),
    ).toBe(false);
    expect(
      isMcpProbeRejection(
        new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, "HTTP 401", {
          status: 401,
        }),
      ),
    ).toBe(false);
  });

  it("normalizes unknown settings to auto", () => {
    expect(normalizeMcpProtocolSetting("legacy")).toBe("legacy");
    expect(normalizeMcpProtocolSetting("2026-07-28")).toBe("2026-07-28");
    expect(normalizeMcpProtocolSetting("2025-11-25")).toBe("auto");
    expect(normalizeMcpProtocolSetting(undefined)).toBe("auto");
  });

  it("keys verdicts by everything that can select a different server", () => {
    const key = mcpProtocolVerdictKey(stdio);
    expect(mcpProtocolVerdictKey({ ...stdio, toolPolicy: "allow" })).toBe(key);
    expect(mcpProtocolVerdictKey({ ...stdio, args: ["b"] })).not.toBe(key);
    const withEnv = mcpProtocolVerdictKey({
      ...stdio,
      env: { TOKEN: "secret-value", A: "1" },
    });
    expect(withEnv).not.toBe(key);
    expect(withEnv).not.toContain("secret-value");
    expect(
      mcpProtocolVerdictKey({
        ...stdio,
        env: { A: "1", TOKEN: "secret-value" },
      }),
    ).toBe(withEnv);
    expect(
      mcpProtocolVerdictKey({ ...http, headers: { Authorization: "x" } }),
    ).not.toBe(mcpProtocolVerdictKey(http));
    expect(
      mcpProtocolVerdictKey({ ...http, url: "https://other.test" }),
    ).not.toBe(mcpProtocolVerdictKey(http));
  });
});
