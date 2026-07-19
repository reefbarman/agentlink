import {
  CURRENT_SANDBOX_POLICY_VERSION,
  serializeSandboxLaunchBinding,
  type ApprovedSandboxCapabilityGrant,
  type SandboxLaunchBindingInput,
  validateCheckpointBSandboxCapabilityRequest,
  validateSandboxCapabilityGrant,
} from "./sandboxPolicy.js";
import { describe, expect, it } from "vitest";

const grant: ApprovedSandboxCapabilityGrant = {
  grantId: "grant-1",
  bindingDigest: "binding-1",
  policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
  sessionId: "session-1",
  issuedAt: 100,
  expiresAt: 200,
  auditId: "audit-1",
};

function validate(
  overrides: Partial<Parameters<typeof validateSandboxCapabilityGrant>[0]> = {},
) {
  return validateSandboxCapabilityGrant({
    grant,
    now: 150,
    sessionId: "session-1",
    bindingDigest: "binding-1",
    policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
    ...overrides,
  });
}

const binding: SandboxLaunchBindingInput = {
  command: "npm test",
  cwd: "/workspace",
  environment: { PATH: "/usr/bin", TERM: "xterm-256color" },
  inlineFiles: [
    { name: "fixture.json", bytes: 2, sha256: "abc123" },
    { name: "script.sh", bytes: 12, sha256: "def456" },
  ],
  sessionId: "session-1",
  policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
  profileId: "workspace-write",
  capability: { publicNetwork: true },
};

describe("sandbox launch bindings", () => {
  it("is stable across environment and inline-file declaration order", () => {
    expect(
      serializeSandboxLaunchBinding({
        ...binding,
        environment: { TERM: "xterm-256color", PATH: "/usr/bin" },
        inlineFiles: [...binding.inlineFiles].reverse(),
      }),
    ).toBe(serializeSandboxLaunchBinding(binding));
  });

  it.each([
    ["command", { command: "npm run lint" }],
    ["cwd", { cwd: "/workspace/subdir" }],
    [
      "environment value",
      { environment: { ...binding.environment, TERM: "dumb" } },
    ],
    ["environment presence", { environment: { PATH: "/usr/bin" } }],
    [
      "inline-file hash",
      {
        inlineFiles: [
          { ...binding.inlineFiles[0], sha256: "changed" },
          binding.inlineFiles[1],
        ],
      },
    ],
    ["session", { sessionId: "session-2" }],
    ["policy version", { policyVersion: "future-policy" }],
    ["profile", { profileId: "read-only" }],
    ["capability", { capability: { publicNetwork: false } }],
  ])("changes when the %s changes", (_label, changes) => {
    expect(serializeSandboxLaunchBinding({ ...binding, ...changes })).not.toBe(
      serializeSandboxLaunchBinding(binding),
    );
  });

  it("rejects duplicate inline-file names", () => {
    expect(() =>
      serializeSandboxLaunchBinding({
        ...binding,
        inlineFiles: [binding.inlineFiles[0], binding.inlineFiles[0]],
      }),
    ).toThrow("Duplicate inline file name");
  });
});

describe("Checkpoint B sandbox capabilities", () => {
  it("accepts absent, blocked, and public-network requests", () => {
    expect(validateCheckpointBSandboxCapabilityRequest(undefined)).toEqual({
      ok: true,
      publicNetwork: false,
    });
    expect(validateCheckpointBSandboxCapabilityRequest({})).toEqual({
      ok: true,
      publicNetwork: false,
    });
    expect(
      validateCheckpointBSandboxCapabilityRequest({
        unrestrictedPublicNetwork: true,
      }),
    ).toEqual({ ok: true, publicNetwork: true });
  });

  it("rejects every deferred capability field", () => {
    expect(
      validateCheckpointBSandboxCapabilityRequest({
        readPaths: [],
        writePaths: ["/tmp"],
        networkDomains: ["example.com"],
        privateNetworkTargets: ["127.0.0.1"],
      }),
    ).toEqual({
      ok: false,
      reason: "unsupported_capability",
      fields: [
        "readPaths",
        "writePaths",
        "networkDomains",
        "privateNetworkTargets",
      ],
    });
  });
});

describe("sandbox capability grants", () => {
  it("accepts an unused grant for the exact launch binding", () => {
    expect(validate()).toEqual({ ok: true });
  });

  it("rejects revoked grants", () => {
    expect(validate({ grant: { ...grant, revokedAt: 125 } })).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("rejects consumed grants", () => {
    expect(validate({ grant: { ...grant, consumedAt: 125 } })).toEqual({
      ok: false,
      reason: "consumed",
    });
  });

  it("rejects a grant at or after expiry", () => {
    expect(validate({ now: grant.expiresAt })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a grant from another session", () => {
    expect(validate({ sessionId: "session-2" })).toEqual({
      ok: false,
      reason: "wrong_session",
    });
  });

  it("rejects a grant after any launch-binding change", () => {
    expect(validate({ bindingDigest: "binding-2" })).toEqual({
      ok: false,
      reason: "wrong_binding",
    });
  });

  it("rejects a grant issued for another policy version", () => {
    expect(
      validate({ grant: { ...grant, policyVersion: "old-policy" } }),
    ).toEqual({
      ok: false,
      reason: "wrong_policy_version",
    });
  });

  it("rejects a validator request for an unknown policy version", () => {
    expect(validate({ policyVersion: "future-policy" })).toEqual({
      ok: false,
      reason: "wrong_policy_version",
    });
  });
});
