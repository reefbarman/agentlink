import {
  budgetSandboxEnvironment,
  buildSandboxPolicyEnvironment,
  resolveSandboxShellEnvironmentPolicy,
} from "./sandboxEnvironmentPolicy.js";
import { describe, expect, it } from "vitest";

const hostEnvironment = {
  HOME: "/Users/test",
  LOGNAME: "test",
  PATH: "/opt/homebrew/bin:/usr/bin:/bin",
  SHELL: "/bin/zsh",
  USER: "test",
  TMPDIR: "/private/tmp/test",
  LANG: "en_US.UTF-8",
  OPENAI_API_KEY: "key-value",
  SERVICE_SECRET: "secret-value",
  SESSION_TOKEN: "token-value",
  CUSTOM_FLAG: "host",
};

describe("sandboxEnvironmentPolicy", () => {
  it("inherits the full host environment including credential-like names by default", () => {
    const result = buildSandboxPolicyEnvironment(hostEnvironment);

    expect(result.policy).toEqual({
      inherit: "all",
      ignoreDefaultExcludes: true,
      exclude: [],
      set: {},
      includeOnly: [],
      useProfile: false,
    });
    expect(result.environment).toMatchObject(hostEnvironment);
    expect(result.provenance).toMatchObject(
      Object.fromEntries(
        Object.keys(hostEnvironment).map((name) => [name, "host-inherited"]),
      ),
    );
  });

  it("supports core and none inheritance", () => {
    expect(
      buildSandboxPolicyEnvironment(hostEnvironment, { inherit: "core" })
        .environment,
    ).toEqual({
      HOME: "/Users/test",
      LOGNAME: "test",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      SHELL: "/bin/zsh",
      USER: "test",
    });
    expect(
      buildSandboxPolicyEnvironment(hostEnvironment, { inherit: "none" })
        .environment,
    ).toEqual({});
  });

  it("applies default excludes, custom excludes, set, and include-only in Codex order", () => {
    const result = buildSandboxPolicyEnvironment(hostEnvironment, {
      ignoreDefaultExcludes: false,
      exclude: ["CUSTOM_*", "lang"],
      set: {
        CUSTOM_FLAG: "set-after-exclude",
        SESSION_TOKEN: "set-after-default-exclude",
        CI: "1",
      },
      includeOnly: ["path", "custom_*", "session_*"],
    });

    expect(result.environment).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      CUSTOM_FLAG: "set-after-exclude",
      SESSION_TOKEN: "set-after-default-exclude",
    });
    expect(result.provenance).toEqual({
      PATH: "host-inherited",
      CUSTOM_FLAG: "policy-set",
      SESSION_TOKEN: "policy-set",
    });
  });

  it("evicts only host-inherited entries by encoded size and name", () => {
    const result = budgetSandboxEnvironment(
      {
        HOST_B: "x".repeat(20),
        HOST_A: "x".repeat(20),
        POLICY_VALUE: "protected",
        COMMAND_VALUE: "protected",
      },
      {
        HOST_B: "host-inherited",
        HOST_A: "host-inherited",
        POLICY_VALUE: "policy-set",
        COMMAND_VALUE: "per-command",
      },
      "true",
      112,
    );

    expect(result.environment).toEqual({
      HOST_B: "x".repeat(20),
      POLICY_VALUE: "protected",
      COMMAND_VALUE: "protected",
    });
    expect(result.dropped).toEqual([{ name: "HOST_A", bytes: 28 }]);
    expect(result.estimatedBytes).toBeLessThanOrEqual(112);
  });

  it("fails closed when protected contributors alone exceed the budget", () => {
    expect(() =>
      budgetSandboxEnvironment(
        { POLICY_VALUE: "x".repeat(100) },
        { POLICY_VALUE: "policy-set" },
        "true",
        64,
      ),
    ).toThrow(/protected environment contributors exceed.*POLICY_VALUE/);
  });

  it("treats environment patterns case-insensitively", () => {
    expect(
      buildSandboxPolicyEnvironment(hostEnvironment, {
        exclude: ["custom_*"],
        includeOnly: ["home", "path"],
      }).environment,
    ).toEqual({
      HOME: "/Users/test",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    });
  });

  it("rejects malformed policies", () => {
    expect(() =>
      resolveSandboxShellEnvironmentPolicy({ inherit: "invalid" as "all" }),
    ).toThrow("Unsupported sandbox environment inheritance");
    expect(() =>
      resolveSandboxShellEnvironmentPolicy({ exclude: [""] }),
    ).toThrow("must be a non-empty pattern");
    expect(() =>
      resolveSandboxShellEnvironmentPolicy({ set: { "BAD-NAME": "value" } }),
    ).toThrow("invalid variable");
    expect(() =>
      resolveSandboxShellEnvironmentPolicy({ set: { VALID: "bad\0value" } }),
    ).toThrow("invalid value");
  });
});
