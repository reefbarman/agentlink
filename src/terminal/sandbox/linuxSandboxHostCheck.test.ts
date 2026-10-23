import { describe, expect, it, vi } from "vitest";

import type { LinuxSandboxPrerequisites } from "@agentlink/sandbox";
import { createLinuxSandboxHostCheck } from "./linuxSandboxHostCheck.js";

const passing = (ripgrep: string): LinuxSandboxPrerequisites => ({
  available: true,
  checks: [
    { id: "platform", status: "pass", detail: "Linux x64" },
    { id: "bubblewrap", status: "pass", detail: "/usr/bin/bwrap" },
    { id: "socat", status: "pass", detail: "/usr/bin/socat" },
    { id: "ripgrep", status: "pass", detail: ripgrep },
    { id: "seccomp-helper", status: "pass", detail: "/ext/apply-seccomp" },
    { id: "namespaces", status: "pass", detail: "ok" },
  ],
});

function harness(
  overrides: {
    nodePtyAvailable?: boolean;
    ripgrep?: string | Error;
    result?: LinuxSandboxPrerequisites | Error;
  } = {},
) {
  const log = vi.fn();
  const checkPrerequisites = vi.fn(async () => {
    const result =
      overrides.result ?? passing("/usr/share/code/resources/app/rg");
    if (result instanceof Error) throw result;
    return result;
  });
  const check = createLinuxSandboxHostCheck({
    nodePtyAvailable: overrides.nodePtyAvailable ?? true,
    runtimeRoot: "/ext/dist/sandbox-runtime",
    resolveRipgrep: async () => {
      const ripgrep = overrides.ripgrep ?? "/usr/share/code/resources/app/rg";
      if (ripgrep instanceof Error) throw ripgrep;
      return ripgrep;
    },
    log,
    checkPrerequisites,
  });
  return { check, checkPrerequisites, log };
}

describe("createLinuxSandboxHostCheck", () => {
  it("passes VS Code's ripgrep to the doctor and the sandbox when it was chosen", async () => {
    const test = harness();
    await expect(test.check()).resolves.toEqual({
      available: true,
      ripgrepPath: "/usr/share/code/resources/app/rg",
    });
    expect(test.checkPrerequisites).toHaveBeenCalledWith({
      runtimeRoot: "/ext/dist/sandbox-runtime",
      ripgrepPath: "/usr/share/code/resources/app/rg",
    });
  });

  it("leaves ripgrep to the helper's default when the doctor fell back to /usr/bin/rg", async () => {
    const test = harness({ ripgrep: "rg", result: passing("/usr/bin/rg") });
    await expect(test.check()).resolves.toEqual({
      available: true,
      ripgrepPath: undefined,
    });
  });

  it("runs the doctor once per window", async () => {
    const test = harness();
    await test.check();
    await test.check();
    expect(test.checkPrerequisites).toHaveBeenCalledTimes(1);
  });

  it("is unavailable without node-pty and never runs the doctor", async () => {
    const test = harness({ nodePtyAvailable: false });
    await expect(test.check()).resolves.toMatchObject({ available: false });
    expect(test.checkPrerequisites).not.toHaveBeenCalled();
  });

  it("reports failing checks and logs their fixes", async () => {
    const test = harness({
      result: {
        available: false,
        checks: [
          { id: "platform", status: "pass", detail: "Linux x64" },
          {
            id: "namespaces",
            status: "fail",
            detail: "AppArmor restricts unprivileged user namespaces.",
            fix: "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
          },
        ],
      },
    });
    await expect(test.check()).resolves.toEqual({
      available: false,
      detail: "AppArmor restricts unprivileged user namespaces.",
    });
    expect(test.log).toHaveBeenCalledWith(
      expect.stringContaining("apparmor_restrict_unprivileged_userns=0"),
    );
  });

  it("fails closed when the doctor or ripgrep lookup throws", async () => {
    const thrown = harness({ result: new Error("spawn EACCES") });
    await expect(thrown.check()).resolves.toMatchObject({
      available: false,
      detail: expect.stringContaining("spawn EACCES"),
    });
    const noRipgrep = harness({ ripgrep: new Error("no rg") });
    await expect(noRipgrep.check()).resolves.toMatchObject({
      available: true,
    });
    expect(noRipgrep.checkPrerequisites).toHaveBeenCalledWith({
      runtimeRoot: "/ext/dist/sandbox-runtime",
    });
  });
});
