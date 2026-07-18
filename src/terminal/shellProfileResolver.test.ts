import { describe, expect, it } from "vitest";

import { resolveHostShellProfile } from "./shellProfileResolver.js";

function input() {
  return {
    platform: "darwin" as const,
    defaultProfileName: "zsh",
    profiles: {
      zsh: {
        path: ["", "  /bin/zsh  ", "/usr/local/bin/zsh"],
        args: ["-l"],
        env: { PROFILE_VALUE: "profile", REMOVE_ME: null },
      },
    },
    platformEnvironment: {
      PLATFORM_VALUE: "platform",
      SHARED: "platform",
    },
    baseEnvironment: {
      PATH: "/usr/bin:/bin",
      SHARED: "base",
      REMOVE_ME: "base",
      UNDEFINED_VALUE: undefined,
    },
    fallbackShellPath: "/bin/bash",
    fallbackShellArgs: ["-l"],
    cwd: "/workspace",
  };
}

describe("host shell profile resolution", () => {
  it("resolves the selected concrete profile with deterministic precedence", () => {
    expect(resolveHostShellProfile(input())).toEqual({
      profileName: "zsh",
      provenance: "configured",
      shellPath: "/bin/zsh",
      shellArgs: ["-l"],
      environment: {
        PATH: "/usr/bin:/bin",
        SHARED: "platform",
        PLATFORM_VALUE: "platform",
        PROFILE_VALUE: "profile",
      },
      cwd: "/workspace",
    });
  });

  it("preserves a string args setting as one literal argument", () => {
    const resolution = resolveHostShellProfile({
      ...input(),
      profiles: { zsh: { path: "/bin/zsh", args: "--login --no-rcs" } },
    });
    expect(resolution.shellArgs).toEqual(["--login --no-rcs"]);
  });

  it("falls back with a warning when the selected profile is missing", () => {
    expect(
      resolveHostShellProfile({
        ...input(),
        defaultProfileName: "missing",
      }),
    ).toMatchObject({
      profileName: "missing",
      provenance: "fallback",
      shellPath: "/bin/bash",
      shellArgs: ["-l"],
      warning:
        'Configured terminal profile "missing" is unavailable; using the extension-host shell.',
    });
  });

  it("does not pretend a source-only contributed profile is resolved", () => {
    expect(
      resolveHostShellProfile({
        ...input(),
        defaultProfileName: "extension profile",
        profiles: {
          "extension profile": {
            source: "some.extension",
            env: { SOURCE_ONLY: "must-not-leak" },
          },
        },
      }),
    ).toMatchObject({
      provenance: "fallback",
      shellPath: "/bin/bash",
      warning:
        'Terminal profile "extension profile" is contributed by "some.extension" without a resolvable executable path; using the extension-host shell.',
    });
    expect(
      resolveHostShellProfile({
        ...input(),
        defaultProfileName: "extension profile",
        profiles: {
          "extension profile": {
            source: "some.extension",
            env: { SOURCE_ONLY: "must-not-leak" },
          },
        },
      }).environment,
    ).not.toHaveProperty("SOURCE_ONLY");
  });

  it("uses the fallback without a warning when no default profile is selected", () => {
    const resolution = resolveHostShellProfile({
      ...input(),
      defaultProfileName: undefined,
    });
    expect(resolution).toMatchObject({
      profileName: "Extension Host Shell",
      provenance: "fallback",
      shellPath: "/bin/bash",
    });
    expect(resolution.warning).toBeUndefined();
  });

  it("applies null deletion in platform and profile environment layers", () => {
    const resolution = resolveHostShellProfile({
      ...input(),
      platformEnvironment: { PATH: null, KEEP: "platform" },
      profiles: {
        zsh: {
          path: "/bin/zsh",
          env: { KEEP: null, PROFILE_ONLY: "value" },
        },
      },
    });
    expect(resolution.environment).toEqual({
      SHARED: "base",
      REMOVE_ME: "base",
      PROFILE_ONLY: "value",
    });
  });
});
