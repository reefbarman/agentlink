import { decideHostShellLaunch } from "./hostShellLaunchPolicy.js";
import {
  resolveHostShellProfile,
  type ResolvedHostShellProfile,
} from "./shellProfileResolver.js";
import { describe, expect, it } from "vitest";

function profile(
  shellPath: string,
  overrides: Partial<ResolvedHostShellProfile> = {},
): ResolvedHostShellProfile {
  return {
    profileName: "Test Shell",
    provenance: "configured",
    shellPath,
    shellArgs: ["-l"],
    environment: { PATH: "/usr/bin:/bin" },
    cwd: "/workspace",
    ...overrides,
  };
}

const localDarwin = { platform: "darwin", remoteName: undefined };

describe("host shell launch policy", () => {
  it.each([
    ["/bin/bash", "bash"],
    ["/usr/local/bin/zsh", "zsh"],
    ["bash", "bash"],
    ["C:\\tools\\zsh", "zsh"],
  ] as const)(
    "selects integrated mode for supported shell path %s",
    (shellPath, integrationKind) => {
      const resolved = profile(shellPath);

      expect(
        decideHostShellLaunch({ host: localDarwin, profile: resolved }),
      ).toEqual({
        mode: "custom-integrated",
        reason: "shell-integration-supported",
        message: `Use the custom terminal with ${integrationKind} shell integration.`,
        executable: integrationKind,
        integrationKind,
        profile: resolved,
      });
    },
  );

  it.each(["/bin/sh", "/bin/dash", "/usr/local/bin/ksh", "mksh"])(
    "permits conservative raw degraded mode for %s",
    (shellPath) => {
      const decision = decideHostShellLaunch({
        host: localDarwin,
        profile: profile(shellPath),
      });

      expect(decision).toMatchObject({
        mode: "custom-raw",
        reason: "raw-shell-compatible",
      });
      expect(decision.message).toContain("raw degraded mode");
    },
  );

  it.each([
    ["/opt/homebrew/bin/fish", "fish"],
    ["/usr/local/bin/FISH", "FISH"],
    ["/usr/local/bin/pwsh", "pwsh"],
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "pwsh.exe"],
    [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "powershell.exe",
    ],
    ["PowerShell", "PowerShell"],
  ] as const)(
    "explicitly falls back to the native terminal for %s",
    (shellPath, executable) => {
      const decision = decideHostShellLaunch({
        host: localDarwin,
        profile: profile(shellPath),
      });

      expect(decision).toMatchObject({
        mode: "native-fallback",
        reason: "native-shell-required",
        executable,
      });
      expect(decision.message).toContain("native VS Code terminal");
    },
  );

  it.each([
    "/bin/csh",
    "/bin/tcsh",
    "/opt/custom/nu",
    "/bin/rbash",
    "/opt/homebrew/bin/BASH",
    "ZsH",
    "/bin/DASH",
    "/bin/bash/",
    "C:\\tools\\zsh\\",
    "",
  ])(
    "fails closed to native fallback for unallowlisted shell %j",
    (shellPath) => {
      const decision = decideHostShellLaunch({
        host: localDarwin,
        profile: profile(shellPath),
      });

      expect(decision).toMatchObject({
        mode: "native-fallback",
        reason: "shell-unsupported",
      });
    },
  );

  it.each([
    { platform: "linux" },
    { platform: "win32" },
    { platform: "darwin", remoteName: "wsl" },
    { platform: "darwin", remoteName: "ssh-remote" },
    { platform: "darwin", remoteName: "dev-container" },
  ])("gives unsupported host fallback precedence for %j", (host) => {
    const resolved = profile("/bin/zsh");

    expect(decideHostShellLaunch({ host, profile: resolved })).toEqual({
      mode: "native-fallback",
      reason: "host-unsupported",
      message:
        "The custom terminal is unavailable on this extension host; use the native VS Code terminal.",
      executable: "zsh",
      profile: resolved,
    });
  });

  it("uses the resolved executable rather than the profile display name", () => {
    expect(
      decideHostShellLaunch({
        host: localDarwin,
        profile: profile("/bin/fish", { profileName: "zsh" }),
      }),
    ).toMatchObject({
      mode: "native-fallback",
      reason: "native-shell-required",
      executable: "fish",
    });
    expect(
      decideHostShellLaunch({
        host: localDarwin,
        profile: profile("/bin/zsh", { profileName: "PowerShell" }),
      }),
    ).toMatchObject({
      mode: "custom-integrated",
      integrationKind: "zsh",
    });
  });

  it("supports configured profiles without mutating resolved launch data", () => {
    const resolved = resolveHostShellProfile({
      platform: "darwin",
      defaultProfileName: "Login Bash",
      profiles: {
        "Login Bash": {
          path: "/bin/bash",
          args: ["-l"],
          env: { PROFILE: "configured" },
        },
      },
      baseEnvironment: { PATH: "/usr/bin:/bin" },
      fallbackShellPath: "/bin/zsh",
      cwd: "/workspace",
    });

    const decision = decideHostShellLaunch({
      host: localDarwin,
      profile: resolved,
    });

    expect(resolved.provenance).toBe("configured");
    expect(decision).toMatchObject({
      mode: "custom-integrated",
      integrationKind: "bash",
      profile: {
        provenance: "configured",
        shellArgs: ["-l"],
        environment: { PATH: "/usr/bin:/bin", PROFILE: "configured" },
      },
    });
    expect(decision.profile).toBe(resolved);
  });

  it("applies compatibility to the actual extension-host fallback shell", () => {
    const integratedFallback = resolveHostShellProfile({
      platform: "darwin",
      defaultProfileName: "Missing",
      profiles: {},
      baseEnvironment: { PATH: "/usr/bin:/bin" },
      fallbackShellPath: "/bin/zsh",
      fallbackShellArgs: ["-l"],
      cwd: "/workspace",
    });
    const nativeFallback = resolveHostShellProfile({
      platform: "darwin",
      defaultProfileName: undefined,
      baseEnvironment: { PATH: "/usr/bin:/bin" },
      fallbackShellPath: "/opt/homebrew/bin/fish",
      cwd: "/workspace",
    });

    expect(integratedFallback.provenance).toBe("fallback");
    expect(
      decideHostShellLaunch({
        host: localDarwin,
        profile: integratedFallback,
      }),
    ).toMatchObject({
      mode: "custom-integrated",
      integrationKind: "zsh",
      profile: { provenance: "fallback" },
    });
    expect(
      decideHostShellLaunch({ host: localDarwin, profile: nativeFallback }),
    ).toMatchObject({
      mode: "native-fallback",
      reason: "native-shell-required",
      executable: "fish",
      profile: { provenance: "fallback" },
    });
  });

  it("treats an empty remote name as a supported local Darwin host", () => {
    expect(
      decideHostShellLaunch({
        host: { platform: "darwin", remoteName: "" },
        profile: profile("/bin/bash"),
      }),
    ).toMatchObject({ mode: "custom-integrated", integrationKind: "bash" });
  });
});
