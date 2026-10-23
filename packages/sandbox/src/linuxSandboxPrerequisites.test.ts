import { describe, expect, it, vi } from "vitest";

import {
  LINUX_SANDBOX_BWRAP_PATH,
  checkLinuxSandboxPrerequisites,
  linuxSandboxApplySeccompPath,
  type CheckLinuxSandboxPrerequisitesOptions,
  type LinuxSandboxProbeResult,
} from "./linuxSandboxPrerequisites.js";

const runtimeRoot = "/ext/dist/sandbox-runtime";
const applySeccomp = linuxSandboxApplySeccompPath(runtimeRoot, "x64");
const allTools = [
  LINUX_SANDBOX_BWRAP_PATH,
  "/usr/bin/socat",
  "/usr/bin/rg",
  "/usr/bin/which",
  applySeccomp,
];

function harness({
  executables = allTools,
  files = {},
  probe = { exitCode: 0, stdout: "", stderr: "" },
  version = { exitCode: 0, stdout: "bubblewrap 0.11.1\n", stderr: "" },
  ...overrides
}: {
  executables?: readonly string[];
  files?: Record<string, string>;
  probe?: LinuxSandboxProbeResult;
  version?: LinuxSandboxProbeResult;
} & Partial<CheckLinuxSandboxPrerequisitesOptions> = {}) {
  const runProbe = vi.fn(async (_command: string, args: readonly string[]) =>
    args[0] === "--version" ? version : probe,
  );
  const options: CheckLinuxSandboxPrerequisitesOptions = {
    runtimeRoot,
    platform: "linux",
    architecture: "x64",
    isExecutableFile: (filePath) => executables.includes(filePath),
    readTextFile: (filePath) => files[filePath],
    runProbe,
    ...overrides,
  };
  return { options, runProbe };
}

function check(
  result: Awaited<ReturnType<typeof checkLinuxSandboxPrerequisites>>,
  id: string,
) {
  return result.checks.find((entry) => entry.id === id);
}

describe("checkLinuxSandboxPrerequisites", () => {
  it("passes when every tool is present and the namespace probe runs", async () => {
    const test = harness();
    const result = await checkLinuxSandboxPrerequisites(test.options);

    expect(result.available).toBe(true);
    expect(result.checks.map((entry) => entry.id)).toEqual([
      "platform",
      "bubblewrap",
      "socat",
      "ripgrep",
      "which",
      "seccomp-helper",
      "namespaces",
    ]);
    expect(test.runProbe).toHaveBeenLastCalledWith(
      LINUX_SANDBOX_BWRAP_PATH,
      expect.arrayContaining([
        "--unshare-all",
        "--cap-drop",
        "ALL",
        "--",
        applySeccomp,
        "/bin/true",
      ]),
    );
  });

  it("names the install command for the distribution", async () => {
    const ubuntu = await checkLinuxSandboxPrerequisites(
      harness({
        executables: [LINUX_SANDBOX_BWRAP_PATH, applySeccomp],
        files: { "/etc/os-release": 'ID=ubuntu\nID_LIKE="debian"\n' },
      }).options,
    );
    expect(ubuntu.available).toBe(false);
    expect(check(ubuntu, "socat")?.fix).toBe("Run `sudo apt install socat`.");
    expect(check(ubuntu, "ripgrep")?.fix).toBe(
      "Run `sudo apt install ripgrep`.",
    );

    const fedora = await checkLinuxSandboxPrerequisites(
      harness({
        executables: [applySeccomp],
        files: { "/etc/os-release": "ID=fedora\n" },
      }).options,
    );
    expect(check(fedora, "bubblewrap")?.fix).toBe(
      "Run `sudo dnf install bubblewrap`.",
    );
    expect(check(fedora, "namespaces")?.status).toBe("skipped");
    // Minimal Fedora and Arch leave out `which`, which the runtime uses to
    // find ripgrep. Debian ships it in debianutils.
    expect(check(fedora, "which")?.fix).toBe("Run `sudo dnf install which`.");
    expect(check(ubuntu, "which")?.fix).toBe(
      "Run `sudo apt install debianutils`.",
    );

    const steamos = await checkLinuxSandboxPrerequisites(
      harness({
        executables: [LINUX_SANDBOX_BWRAP_PATH, "/usr/bin/rg", applySeccomp],
        files: { "/etc/os-release": "ID=steamos\nID_LIKE=arch\n" },
      }).options,
    );
    expect(check(steamos, "socat")?.fix).toContain("sudo pacman -S socat");
    expect(check(steamos, "socat")?.fix).toContain("read-only root");
  });

  it("uses a host-provided ripgrep", async () => {
    const hostRipgrep = "/opt/vscode/resources/app/node_modules/rg";
    const result = await checkLinuxSandboxPrerequisites(
      harness({
        executables: [
          LINUX_SANDBOX_BWRAP_PATH,
          "/usr/bin/socat",
          "/bin/which",
          applySeccomp,
          hostRipgrep,
        ],
        ripgrepPath: hostRipgrep,
      }).options,
    );
    expect(check(result, "ripgrep")).toEqual({
      id: "ripgrep",
      status: "pass",
      detail: hostRipgrep,
    });
  });

  it("refuses without the apply-seccomp helper and skips the probe", async () => {
    const test = harness({
      executables: [LINUX_SANDBOX_BWRAP_PATH, "/usr/bin/socat", "/usr/bin/rg"],
    });
    const result = await checkLinuxSandboxPrerequisites(test.options);
    expect(result.available).toBe(false);
    expect(check(result, "seccomp-helper")?.status).toBe("fail");
    expect(check(result, "namespaces")?.status).toBe("skipped");
    expect(test.runProbe).not.toHaveBeenCalled();
  });

  it("explains Ubuntu's AppArmor user namespace restriction", async () => {
    const result = await checkLinuxSandboxPrerequisites(
      harness({
        files: {
          "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n",
        },
        probe: {
          exitCode: 1,
          stdout: "",
          stderr:
            "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n",
        },
      }).options,
    );
    const namespaces = check(result, "namespaces");
    expect(result.available).toBe(false);
    expect(namespaces?.detail).toContain("AppArmor restricts");
    expect(namespaces?.detail).toContain("RTM_NEWADDR");
    expect(namespaces?.fix).toContain(
      "kernel.apparmor_restrict_unprivileged_userns=0",
    );
    expect(namespaces?.fix).toContain("does not change it for you");
  });

  it("reports disabled user namespaces and other probe failures", async () => {
    const disabled = await checkLinuxSandboxPrerequisites(
      harness({
        probe: {
          exitCode: 1,
          stdout: "",
          stderr: "bwrap: setting up uid map: Permission denied\n",
        },
      }).options,
    );
    expect(check(disabled, "namespaces")?.fix).toContain(
      "unprivileged_userns_clone",
    );

    const timedOut = await checkLinuxSandboxPrerequisites(
      harness({
        probe: { exitCode: null, stdout: "", stderr: "", error: "timed out" },
      }).options,
    );
    expect(check(timedOut, "namespaces")?.detail).toBe(
      "The sandbox probe failed (timed out).",
    );
  });

  it("rejects old bubblewrap, WSL 1 and other platforms", async () => {
    const old = await checkLinuxSandboxPrerequisites(
      harness({
        version: { exitCode: 0, stdout: "bubblewrap 0.3.3\n", stderr: "" },
      }).options,
    );
    expect(check(old, "bubblewrap")?.status).toBe("fail");
    expect(old.available).toBe(false);

    const wsl1 = await checkLinuxSandboxPrerequisites(
      harness({
        files: { "/proc/version": "Linux version 4.4.0-19041-Microsoft" },
      }).options,
    );
    expect(wsl1.checks).toEqual([
      expect.objectContaining({ id: "platform", fix: "Use WSL 2." }),
    ]);

    const wsl2 = await checkLinuxSandboxPrerequisites(
      harness({
        files: {
          "/proc/version": "Linux version 5.15.0-microsoft-standard-WSL2",
        },
      }).options,
    );
    expect(wsl2.available).toBe(true);

    const darwin = await checkLinuxSandboxPrerequisites(
      harness({ platform: "darwin" }).options,
    );
    expect(darwin.available).toBe(false);
    const ia32 = await checkLinuxSandboxPrerequisites(
      harness({ architecture: "ia32" }).options,
    );
    expect(ia32.available).toBe(false);
  });
});
