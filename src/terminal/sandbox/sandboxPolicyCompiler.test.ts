import {
  CURRENT_SANDBOX_POLICY_VERSION,
  type SandboxLaunchAuthorization,
} from "../../core/sandboxPolicy.js";
import { describe, expect, it } from "vitest";

import { compileSandboxHelperLaunchRequest } from "./sandboxPolicyCompiler.js";

function authorization(
  overrides: Partial<SandboxLaunchAuthorization> = {},
): SandboxLaunchAuthorization {
  return {
    bindingDigest: "binding-1",
    policy: {
      version: CURRENT_SANDBOX_POLICY_VERSION,
      profileId: "workspace-write",
      readableRoots: ["/usr", "/workspace", "/private/tmp/session"],
      writableRoots: ["/workspace", "/private/tmp/session"],
      deniedRoots: ["/Users"],
      deniedWriteRoots: ["/workspace/.git", "/workspace/.agentlink"],
      protectedReadOnlyRoots: [
        "/workspace/.git/config",
        "/workspace/.agentlink",
      ],
      structurallyProtectedRoots: ["/workspace/.git"],
      network: { mode: "blocked" },
      environment: {
        inheritHost: false,
        values: {
          HOME: "/private/tmp/session/home",
          TMPDIR: "/private/tmp/session/tmp",
          PATH: "/usr/bin:/bin",
          TERM: "xterm-256color",
        },
      },
      allowedUnixSockets: [],
    },
    ...overrides,
  };
}

function compile(auth = authorization()) {
  return compileSandboxHelperLaunchRequest({
    channelId: "channel-1",
    commandId: "command-1",
    generation: 1,
    command: "npm test",
    cwd: "/workspace",
    shell: "/bin/zsh",
    dimensions: { columns: 80, rows: 24 },
    authorization: auth,
  });
}

describe("compileSandboxHelperLaunchRequest", () => {
  it("compiles a deterministic blocked-network baseline", () => {
    expect(compile()).toEqual({
      version: 2,
      type: "launch",
      channelId: "channel-1",
      commandId: "command-1",
      generation: 1,
      command: "npm test",
      cwd: "/workspace",
      shell: "/bin/zsh",
      dimensions: { columns: 80, rows: 24 },
      environment: {
        HOME: "/private/tmp/session/home",
        PATH: "/usr/bin:/bin",
        TERM: "xterm-256color",
        TMPDIR: "/private/tmp/session/tmp",
      },
      filesystem: {
        allowRead: ["/private/tmp/session", "/usr", "/workspace"],
        allowWrite: ["/private/tmp/session", "/workspace"],
        denyRead: ["/Users"],
        denyWrite: ["/workspace/.agentlink", "/workspace/.git"],
      },
      network: { mode: "blocked" },
      protectedRoots: ["/workspace/.agentlink", "/workspace/.git/config"],
      structurallyProtectedRoots: ["/workspace/.git"],
    });
  });

  it("compiles public proxy only with request intent and a consumed matching grant", () => {
    const base = authorization();
    const elevated = authorization({
      capabilityRequest: { unrestrictedPublicNetwork: true },
      grant: {
        grantId: "grant-1",
        bindingDigest: base.bindingDigest,
        policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
        sessionId: "session-1",
        issuedAt: 100,
        expiresAt: 200,
        auditId: "audit-1",
        consumedAt: 125,
      },
      policy: { ...base.policy, network: { mode: "public-proxy" } },
    });

    expect(compile(elevated).network).toEqual({ mode: "public-proxy" });
  });

  it.each([
    [
      "request without public policy",
      (base: SandboxLaunchAuthorization) => ({
        ...base,
        capabilityRequest: { unrestrictedPublicNetwork: true },
      }),
      "does not match",
    ],
    [
      "public policy without request",
      (base: SandboxLaunchAuthorization) => ({
        ...base,
        policy: { ...base.policy, network: { mode: "public-proxy" as const } },
      }),
      "does not match",
    ],
    [
      "public policy without grant",
      (base: SandboxLaunchAuthorization) => ({
        ...base,
        capabilityRequest: { unrestrictedPublicNetwork: true },
        policy: { ...base.policy, network: { mode: "public-proxy" as const } },
      }),
      "requires an approved grant",
    ],
    [
      "unconsumed public grant",
      (base: SandboxLaunchAuthorization) => ({
        ...base,
        capabilityRequest: { unrestrictedPublicNetwork: true },
        policy: { ...base.policy, network: { mode: "public-proxy" as const } },
        grant: {
          grantId: "grant-1",
          bindingDigest: base.bindingDigest,
          policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
          sessionId: "session-1",
          issuedAt: 100,
          expiresAt: 200,
          auditId: "audit-1",
        },
      }),
      "must be atomically consumed",
    ],
    [
      "grant binding mismatch",
      (base: SandboxLaunchAuthorization) => ({
        ...base,
        capabilityRequest: { unrestrictedPublicNetwork: true },
        policy: { ...base.policy, network: { mode: "public-proxy" as const } },
        grant: {
          grantId: "grant-1",
          bindingDigest: "other",
          policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
          sessionId: "session-1",
          issuedAt: 100,
          expiresAt: 200,
          auditId: "audit-1",
          consumedAt: 125,
        },
      }),
      "does not match",
    ],
    [
      "grant on blocked policy",
      (base: SandboxLaunchAuthorization) => ({
        ...base,
        grant: {
          grantId: "grant-1",
          bindingDigest: base.bindingDigest,
          policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
          sessionId: "session-1",
          issuedAt: 100,
          expiresAt: 200,
          auditId: "audit-1",
          consumedAt: 125,
        },
      }),
      "must not carry a grant",
    ],
  ])("rejects %s", (_label, mutate, message) => {
    expect(() => compile(mutate(authorization()))).toThrow(message);
  });

  it("rejects deferred network, filesystem, socket, and policy expansions", () => {
    const base = authorization();
    expect(() =>
      compile(
        authorization({
          capabilityRequest: { networkDomains: ["example.com"] },
        }),
      ),
    ).toThrow("Unsupported sandbox capabilities");
    expect(() =>
      compile(
        authorization({
          policy: {
            ...base.policy,
            network: {
              mode: "domain-proxy",
              allowedDomains: ["example.com"],
            },
          },
        }),
      ),
    ).toThrow("domain-specific");
    expect(() =>
      compile(
        authorization({
          policy: { ...base.policy, allowedUnixSockets: ["/tmp/socket"] },
        }),
      ),
    ).toThrow("does not allow sandbox Unix sockets");
    expect(() =>
      compile(
        authorization({
          policy: {
            ...base.policy,
            version: "future",
          },
        }),
      ),
    ).toThrow("Unsupported sandbox policy version");
  });

  it("allows a read-only HOME when the host filesystem is readable", () => {
    const base = authorization();
    const hostVisible = authorization({
      policy: {
        ...base.policy,
        readableRoots: ["/"],
        deniedRoots: [],
        environment: {
          inheritHost: false,
          values: {
            ...base.policy.environment.values,
            HOME: "/Users/me",
          },
        },
      },
    });

    expect(compile(hostVisible).environment.HOME).toBe("/Users/me");
  });

  it("rejects unsafe roots, cwd, private directories, and environment values", () => {
    const base = authorization();
    expect(() =>
      compile(
        authorization({
          policy: {
            ...base.policy,
            deniedWriteRoots: [],
          },
        }),
      ),
    ).toThrow("protected root is not covered by denied-write roots");
    expect(() =>
      compile(
        authorization({
          policy: {
            ...base.policy,
            deniedWriteRoots: ["/workspace/.agentlink"],
            protectedReadOnlyRoots: ["/workspace/.agentlink"],
          },
        }),
      ),
    ).toThrow(
      "structurally protected root is not covered by denied-write roots",
    );
    expect(() =>
      compile(
        authorization({
          policy: {
            ...base.policy,
            readableRoots: ["/usr", "/private/tmp/session"],
            protectedReadOnlyRoots: [],
          },
        }),
      ),
    ).toThrow("structurally protected root is not covered by readable roots");
    expect(() =>
      compileSandboxHelperLaunchRequest({
        channelId: "channel-1",
        commandId: "command-1",
        generation: 1,
        command: "pwd",
        cwd: "/outside",
        shell: "/bin/zsh",
        dimensions: { columns: 80, rows: 24 },
        authorization: base,
      }),
    ).toThrow("cwd must be within a readable root");
    expect(() =>
      compile(
        authorization({
          policy: {
            ...base.policy,
            readableRoots: ["/usr", "/workspace", "/private/tmp/session"],
            environment: {
              inheritHost: false,
              values: { ...base.policy.environment.values, HOME: "/Users/me" },
            },
          },
        }),
      ),
    ).toThrow("HOME must be within a readable root");
    expect(() =>
      compile(
        authorization({
          policy: {
            ...base.policy,
            environment: {
              inheritHost: false,
              values: {
                ...base.policy.environment.values,
                TMPDIR: "/Users/me/tmp",
              },
            },
          },
        }),
      ),
    ).toThrow("TMPDIR must be within a writable root");
    expect(() =>
      compile(
        authorization({
          policy: {
            ...base.policy,
            environment: {
              inheritHost: false,
              values: {
                ...base.policy.environment.values,
                SSH_AUTH_SOCK: "/tmp/agent.sock",
              },
            },
          },
        }),
      ),
    ).toThrow("forbidden variable: SSH_AUTH_SOCK");
  });

  it("runs the result through exact helper-frame validation", () => {
    expect(() =>
      compileSandboxHelperLaunchRequest({
        channelId: "channel-1",
        commandId: "command-1",
        generation: 0,
        command: "pwd",
        cwd: "/workspace",
        shell: "/bin/zsh",
        dimensions: { columns: 80, rows: 24 },
        authorization: authorization(),
      }),
    ).toThrow("launch request is invalid");
  });
});
