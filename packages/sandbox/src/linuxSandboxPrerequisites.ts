import { accessSync, constants, readFileSync, statSync } from "node:fs";

import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Linux sandbox doctor. The bubblewrap sandbox runs only when every check
 * passes; otherwise each failing check says what is wrong and how to fix it.
 * It never changes the host itself.
 */

export type LinuxSandboxCheckId =
  | "platform"
  | "bubblewrap"
  | "socat"
  | "ripgrep"
  | "which"
  | "seccomp-helper"
  | "namespaces";

export interface LinuxSandboxCheck {
  readonly id: LinuxSandboxCheckId;
  readonly status: "pass" | "fail" | "skipped";
  readonly detail: string;
  /** What to do when the check fails. */
  readonly fix?: string;
}

export interface LinuxSandboxPrerequisites {
  readonly available: boolean;
  readonly checks: readonly LinuxSandboxCheck[];
}

export interface LinuxSandboxProbeResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface CheckLinuxSandboxPrerequisitesOptions {
  /** Staged `dist/sandbox-runtime` directory holding `vendor/seccomp`. */
  readonly runtimeRoot: string;
  /** Host-provided ripgrep, such as VS Code's bundled `rg`. */
  readonly ripgrepPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly isExecutableFile?: (filePath: string) => boolean;
  readonly readTextFile?: (filePath: string) => string | undefined;
  readonly runProbe?: (
    command: string,
    args: readonly string[],
  ) => Promise<LinuxSandboxProbeResult>;
}

// Keep these in step with scripts/sandbox-linux-runtime.mjs, which the
// packaged helper uses to resolve the same tools at launch.
export const LINUX_SANDBOX_BWRAP_PATH = "/usr/bin/bwrap";
const SOCAT_CANDIDATES = ["/usr/bin/socat", "/bin/socat"] as const;
const RIPGREP_CANDIDATES = ["/usr/bin/rg"] as const;
// The sandbox runtime finds ripgrep by running `which`, which minimal Fedora
// and Arch installs leave out.
const WHICH_CANDIDATES = ["/usr/bin/which", "/bin/which"] as const;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_PROBE_OUTPUT_BYTES = 16 * 1024;

export function linuxSandboxApplySeccompPath(
  runtimeRoot: string,
  architecture: string,
): string {
  return path.join(
    runtimeRoot,
    "vendor",
    "seccomp",
    architecture,
    "apply-seccomp",
  );
}

// Follows symlinks like scripts/sandbox-linux-runtime.mjs: Debian 13 installs
// `/usr/bin/socat` as a link to `socat1`.
function defaultIsExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultReadTextFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function defaultRunProbe(
  command: string,
  args: readonly string[],
): Promise<LinuxSandboxProbeResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: LinuxSandboxProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ exitCode: null, stdout, stderr, error: "timed out" });
    }, PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_PROBE_OUTPUT_BYTES) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_PROBE_OUTPUT_BYTES) {
        stderr += chunk.toString("utf8");
      }
    });
    child.once("error", (error) =>
      finish({ exitCode: null, stdout, stderr, error: error.message }),
    );
    child.once("close", (exitCode) => finish({ exitCode, stdout, stderr }));
  });
}

type PackageManager = "apt" | "dnf" | "pacman" | "zypper" | undefined;

function osReleaseIds(readTextFile: (filePath: string) => string | undefined) {
  const text = readTextFile("/etc/os-release") ?? "";
  const field = (name: string) =>
    text
      .match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]
      ?.replace(/^"|"$/g, "")
      .toLowerCase() ?? "";
  return [field("ID"), ...field("ID_LIKE").split(/\s+/)].filter(Boolean);
}

function packageManagerFor(ids: readonly string[]): PackageManager {
  if (ids.some((id) => id === "debian" || id === "ubuntu")) return "apt";
  if (ids.some((id) => ["fedora", "rhel", "centos"].includes(id))) {
    return "dnf";
  }
  if (ids.some((id) => id === "arch" || id === "steamos")) return "pacman";
  if (ids.some((id) => id.startsWith("opensuse") || id === "suse")) {
    return "zypper";
  }
  return undefined;
}

function installCommand(
  manager: PackageManager,
  packages: readonly string[],
): string {
  const names = packages.join(" ");
  switch (manager) {
    case "apt":
      return `sudo apt install ${names}`;
    case "dnf":
      return `sudo dnf install ${names}`;
    case "pacman":
      return `sudo pacman -S ${names}`;
    case "zypper":
      return `sudo zypper install ${names}`;
    default:
      return `install ${names} with your package manager`;
  }
}

function installFix(
  manager: PackageManager,
  ids: readonly string[],
  packages: readonly string[],
): string {
  const command = installCommand(manager, packages);
  return ids.includes("steamos")
    ? `${command}. SteamOS has a read-only root, so this needs \`sudo steamos-readonly disable\` first and is undone by system updates.`
    : `Run \`${command}\`.`;
}

function parseBwrapVersion(output: string): number[] | undefined {
  const match = output.match(/bubblewrap\s+(\d+)\.(\d+)(?:\.(\d+))?/);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
    : undefined;
}

/**
 * Checks whether the bubblewrap sandbox can run on this host: bubblewrap,
 * socat, ripgrep and AgentLink's apply-seccomp helper must be present, and
 * the kernel must let bubblewrap and apply-seccomp create their namespaces.
 */
export async function checkLinuxSandboxPrerequisites(
  options: CheckLinuxSandboxPrerequisitesOptions,
): Promise<LinuxSandboxPrerequisites> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const isExecutableFile = options.isExecutableFile ?? defaultIsExecutableFile;
  const readTextFile = options.readTextFile ?? defaultReadTextFile;
  const runProbe = options.runProbe ?? defaultRunProbe;
  const checks: LinuxSandboxCheck[] = [];
  const done = (): LinuxSandboxPrerequisites => ({
    available: checks.every((check) => check.status === "pass"),
    checks,
  });

  const kernelVersion = readTextFile("/proc/version") ?? "";
  const wsl1 = /microsoft/i.test(kernelVersion) && !/WSL2/i.test(kernelVersion);
  if (platform !== "linux" || wsl1) {
    checks.push({
      id: "platform",
      status: "fail",
      detail: wsl1
        ? "WSL 1 cannot run bubblewrap."
        : `The bubblewrap sandbox runs on Linux, not ${platform}.`,
      ...(wsl1 ? { fix: "Use WSL 2." } : {}),
    });
    return done();
  }
  if (architecture !== "x64" && architecture !== "arm64") {
    checks.push({
      id: "platform",
      status: "fail",
      detail: `Architecture ${architecture} is not supported; the sandbox needs x64 or arm64.`,
    });
    return done();
  }
  checks.push({
    id: "platform",
    status: "pass",
    detail: `Linux ${architecture}`,
  });

  const ids = osReleaseIds(readTextFile);
  const manager = packageManagerFor(ids);

  const hasBwrap = isExecutableFile(LINUX_SANDBOX_BWRAP_PATH);
  checks.push(
    hasBwrap
      ? {
          id: "bubblewrap",
          status: "pass",
          detail: LINUX_SANDBOX_BWRAP_PATH,
        }
      : {
          id: "bubblewrap",
          status: "fail",
          detail: `bubblewrap is not installed at ${LINUX_SANDBOX_BWRAP_PATH}.`,
          fix: installFix(manager, ids, ["bubblewrap"]),
        },
  );

  const socatPath = SOCAT_CANDIDATES.find(isExecutableFile);
  checks.push(
    socatPath
      ? { id: "socat", status: "pass", detail: socatPath }
      : {
          id: "socat",
          status: "fail",
          detail:
            "socat is not installed. The sandbox uses it to route network access through AgentLink's proxy.",
          fix: installFix(manager, ids, ["socat"]),
        },
  );

  const ripgrepPath =
    options.ripgrepPath &&
    path.isAbsolute(options.ripgrepPath) &&
    isExecutableFile(options.ripgrepPath)
      ? options.ripgrepPath
      : RIPGREP_CANDIDATES.find(isExecutableFile);
  checks.push(
    ripgrepPath
      ? { id: "ripgrep", status: "pass", detail: ripgrepPath }
      : {
          id: "ripgrep",
          status: "fail",
          detail: "ripgrep is not available.",
          fix: installFix(manager, ids, ["ripgrep"]),
        },
  );

  const whichPath = WHICH_CANDIDATES.find(isExecutableFile);
  checks.push(
    whichPath
      ? { id: "which", status: "pass", detail: whichPath }
      : {
          id: "which",
          status: "fail",
          detail:
            "The `which` command is not installed. The sandbox uses it to find ripgrep.",
          fix: installFix(manager, ids, [
            manager === "apt" ? "debianutils" : "which",
          ]),
        },
  );

  const applySeccompPath = linuxSandboxApplySeccompPath(
    options.runtimeRoot,
    architecture,
  );
  const hasApplySeccomp = isExecutableFile(applySeccompPath);
  checks.push(
    hasApplySeccomp
      ? { id: "seccomp-helper", status: "pass", detail: applySeccompPath }
      : {
          id: "seccomp-helper",
          status: "fail",
          detail:
            "AgentLink's apply-seccomp helper is missing from this install, so unix sockets could not be blocked.",
          fix: "Install an AgentLink build for linux-x64 or linux-arm64; development builds need `node scripts/build-apply-seccomp.mjs` first.",
        },
  );

  if (!hasBwrap || !hasApplySeccomp) {
    checks.push({
      id: "namespaces",
      status: "skipped",
      detail: "Needs bubblewrap and the apply-seccomp helper.",
    });
    return done();
  }

  const version = await runProbe(LINUX_SANDBOX_BWRAP_PATH, ["--version"]);
  const parsed = parseBwrapVersion(`${version.stdout}\n${version.stderr}`);
  // An unparsed version is not a failure on its own: the namespace probe
  // below decides whether this bubblewrap works.
  if (parsed && parsed[0] === 0 && parsed[1] < 4) {
    checks[checks.findIndex((check) => check.id === "bubblewrap")] = {
      id: "bubblewrap",
      status: "fail",
      detail: `bubblewrap ${parsed.join(".")} is too old; the sandbox needs 0.4 or newer.`,
      fix: installFix(manager, ids, ["bubblewrap"]),
    };
  }

  const probe = await runProbe(LINUX_SANDBOX_BWRAP_PATH, [
    "--new-session",
    "--die-with-parent",
    "--unshare-all",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--",
    applySeccompPath,
    "/bin/true",
  ]);
  if (probe.exitCode === 0) {
    checks.push({
      id: "namespaces",
      status: "pass",
      detail: "bubblewrap and apply-seccomp started a sandboxed process.",
    });
    return done();
  }

  const restricted =
    readTextFile(
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
    )?.trim() === "1";
  const stderr = probe.stderr.trim();
  // The restriction shows up differently depending on where it bites (bwrap
  // setting up loopback, or apply-seccomp writing setgroups), so when it is
  // on it is the diagnosis whatever the probe printed.
  if (restricted) {
    checks.push({
      id: "namespaces",
      status: "fail",
      detail: `AppArmor restricts unprivileged user namespaces (Ubuntu 23.10 and later), which stops the sandbox isolating commands${stderr ? `: ${stderr}` : "."}`,
      fix: "Allow unprivileged user namespaces with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (add it to /etc/sysctl.d to keep it after a reboot). This relaxes a protection for every program on the machine, so AgentLink does not change it for you.",
    });
  } else if (/No permissions|Operation not permitted|uid map/i.test(stderr)) {
    checks.push({
      id: "namespaces",
      status: "fail",
      detail: `bubblewrap cannot create user namespaces: ${stderr}`,
      fix: "Enable unprivileged user namespaces (for example `sudo sysctl -w kernel.unprivileged_userns_clone=1`, or raise `user.max_user_namespaces`).",
    });
  } else {
    checks.push({
      id: "namespaces",
      status: "fail",
      detail: `The sandbox probe failed${probe.error ? ` (${probe.error})` : ""}${stderr ? `: ${stderr}` : "."}`,
    });
  }
  return done();
}
