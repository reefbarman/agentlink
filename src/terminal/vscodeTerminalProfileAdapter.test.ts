import { describe, expect, it } from "vitest";

import {
  adaptVscodeTerminalConfiguration,
  type VscodeTerminalConfigurationSnapshot,
} from "./vscodeTerminalProfileAdapter.js";

function snapshot(
  overrides: Partial<VscodeTerminalConfigurationSnapshot> = {},
): VscodeTerminalConfigurationSnapshot {
  return {
    isWorkspaceTrusted: true,
    platform: "darwin",
    defaultProfile: { globalValue: "Global zsh" },
    profiles: {
      globalValue: {
        "Global zsh": {
          path: "/bin/zsh",
          args: ["-l"],
          env: { GLOBAL: "yes", REMOVE: null },
        },
      },
    },
    environment: { globalValue: { PLATFORM: "global" } },
    baseEnvironment: {
      HOME: "/Users/test",
      REMOVE: "base",
      TOKEN: "materialized",
    },
    fallbackShellPath: "/bin/zsh",
    fallbackShellArgs: ["-l"],
    workspaceDirectories: ["/workspace/project"],
    homeDirectory: "/Users/test",
    ...overrides,
  };
}

describe("VS Code terminal profile adapter", () => {
  it("ignores workspace execution settings until Workspace Trust is granted", () => {
    const untrusted = adaptVscodeTerminalConfiguration(
      snapshot({
        isWorkspaceTrusted: false,
        defaultProfile: {
          globalValue: "Global zsh",
          workspaceValue: "Workspace shell",
        },
        profiles: {
          globalValue: {
            "Global zsh": { path: "/bin/zsh", env: { GLOBAL: "yes" } },
          },
          workspaceValue: {
            "Workspace shell": {
              path: "/workspace/evil-shell",
              args: ["--evil"],
              env: { WORKSPACE_SECRET: "leak" },
            },
          },
        },
        environment: {
          globalValue: { PLATFORM: "global" },
          workspaceValue: { PLATFORM: "workspace", INJECTED: "yes" },
        },
      }),
    );

    expect(untrusted.profile).toMatchObject({
      profileName: "Global zsh",
      shellPath: "/bin/zsh",
    });
    expect(untrusted.profile.environment).toMatchObject({
      PLATFORM: "global",
      GLOBAL: "yes",
    });
    expect(untrusted.profile.environment).not.toHaveProperty("INJECTED");
    expect(untrusted.ignoredUntrustedWorkspaceConfiguration).toBe(true);
    expect(untrusted.warnings[0]).toContain("not trusted");
  });

  it("merges trusted profile and environment scopes in VS Code precedence", () => {
    const adapted = adaptVscodeTerminalConfiguration(
      snapshot({
        defaultProfile: {
          defaultValue: "Default",
          globalValue: "Shared",
          workspaceFolderValue: "Shared",
        },
        profiles: {
          defaultValue: {
            Shared: {
              path: "/bin/bash",
              args: ["-i"],
              env: { A: "default", B: "default" },
            },
          },
          globalValue: {
            Shared: { env: { A: "global", C: "global" } },
          },
          workspaceValue: {
            Shared: { args: ["-l"], env: { B: null } },
          },
          workspaceFolderValue: {
            Shared: { env: { C: "folder" } },
          },
        },
        environment: {
          defaultValue: { PLATFORM: "default", DELETE: "yes" },
          globalValue: { PLATFORM: "global" },
          workspaceValue: { DELETE: null },
          workspaceFolderValue: { FOLDER: "yes" },
        },
      }),
    );

    expect(adapted.profile).toMatchObject({
      profileName: "Shared",
      shellPath: "/bin/bash",
      shellArgs: ["-l"],
      environment: {
        HOME: "/Users/test",
        REMOVE: "base",
        TOKEN: "materialized",
        PLATFORM: "global",
        FOLDER: "yes",
        A: "global",
        C: "folder",
      },
    });
    expect(adapted.profile.environment).not.toHaveProperty("DELETE");
    expect(adapted.profile.environment).not.toHaveProperty("B");
    expect(adapted.nativeFallbackReason).toBeUndefined();
  });

  it.each(["${workspaceFolder}", "${cwd}"])(
    "does not expand the workspace-derived %s variable while untrusted",
    (workspaceVariable) => {
      const adapted = adaptVscodeTerminalConfiguration(
        snapshot({
          isWorkspaceTrusted: false,
          defaultProfile: { globalValue: "Global workspace variable" },
          profiles: {
            globalValue: {
              "Global workspace variable": {
                path: "/bin/zsh",
                args: [`--workspace=${workspaceVariable}`],
              },
            },
          },
          activeEditorDirectory: "/workspace/project/src",
        }),
      );

      expect(adapted.nativeFallbackReason).toBeDefined();
      expect(adapted.profile.provenance).toBe("fallback");
      expect(adapted.profile.cwd).toBe("/workspace/project/src");
    },
  );

  it("materializes only the supported variable allowlist", () => {
    const adapted = adaptVscodeTerminalConfiguration(
      snapshot({
        defaultProfile: { globalValue: "Variables" },
        profiles: {
          globalValue: {
            Variables: {
              path: "${env:HOME}/bin/zsh",
              args: ["--workspace=${workspaceFolder}", "--cwd=${cwd}"],
              env: {
                TOKEN_COPY: "${env:TOKEN}",
                HOME_COPY: "${userHome}",
              },
            },
          },
        },
        activeEditorDirectory: "/workspace/project/src",
      }),
    );

    expect(adapted.profile).toMatchObject({
      shellPath: "/Users/test/bin/zsh",
      shellArgs: [
        "--workspace=/workspace/project",
        "--cwd=/workspace/project/src",
      ],
      cwd: "/workspace/project/src",
    });
    expect(adapted.profile.environment).toMatchObject({
      TOKEN_COPY: "materialized",
      HOME_COPY: "/Users/test",
    });
  });

  it.each([
    ["unknown variable", "${command:evil}/zsh"],
    ["relative executable", "bin/zsh"],
  ])("fails closed for a selected profile with %s", (_label, shellPath) => {
    const adapted = adaptVscodeTerminalConfiguration(
      snapshot({
        defaultProfile: { globalValue: "Unsafe" },
        profiles: { globalValue: { Unsafe: { path: shellPath } } },
      }),
    );

    expect(adapted.profile.provenance).toBe("fallback");
    expect(adapted.nativeFallbackReason).toContain("cannot be materialized");
  });

  it("fails closed for selected source-only and missing profiles", () => {
    const sourceOnly = adaptVscodeTerminalConfiguration(
      snapshot({
        defaultProfile: { globalValue: "Contributed" },
        profiles: {
          globalValue: { Contributed: { source: "extension.shells" } },
        },
      }),
    );
    const missing = adaptVscodeTerminalConfiguration(
      snapshot({
        defaultProfile: { globalValue: "Missing" },
        profiles: { globalValue: {} },
      }),
    );

    expect(sourceOnly.nativeFallbackReason).toBeDefined();
    expect(missing.nativeFallbackReason).toBeDefined();
  });

  it("does not let an unsafe unused profile poison a safe selected profile", () => {
    const adapted = adaptVscodeTerminalConfiguration(
      snapshot({
        defaultProfile: { globalValue: "Safe" },
        profiles: {
          globalValue: {
            Safe: { path: "/bin/zsh" },
            Unsafe: { path: "${command:evil}" },
          },
        },
      }),
    );

    expect(adapted.profile.shellPath).toBe("/bin/zsh");
    expect(adapted.nativeFallbackReason).toBeUndefined();
  });

  it("keeps renderer preference precedence independent of Workspace Trust", () => {
    const adapted = adaptVscodeTerminalConfiguration(
      snapshot({
        isWorkspaceTrusted: false,
        fontFamily: {
          globalValue: "Global Mono",
          workspaceValue: "Workspace Mono",
        },
        fontSize: { workspaceFolderValue: 15 },
        lineHeight: { workspaceValue: -1 },
        letterSpacing: { workspaceValue: 1 },
        cursorStyle: { workspaceValue: "line" },
        cursorBlink: { workspaceValue: true },
        scrollback: { workspaceValue: 2000.8 },
      }),
    );

    expect(adapted.terminal).toEqual({
      fontFamily: "Workspace Mono",
      fontSize: 15,
      letterSpacing: 1,
      cursorStyle: "line",
      cursorBlink: true,
      scrollback: 2000,
    });
  });

  it("selects cwd from active editor, workspace, then home", () => {
    expect(
      adaptVscodeTerminalConfiguration(
        snapshot({ activeEditorDirectory: "/workspace/project/src" }),
      ).profile.cwd,
    ).toBe("/workspace/project/src");
    expect(
      adaptVscodeTerminalConfiguration(
        snapshot({
          activeEditorDirectory: "relative",
          workspaceDirectories: ["relative", "/workspace/second"],
        }),
      ).profile.cwd,
    ).toBe("/workspace/second");
    expect(
      adaptVscodeTerminalConfiguration(
        snapshot({
          activeEditorDirectory: undefined,
          workspaceDirectories: [],
        }),
      ).profile.cwd,
    ).toBe("/Users/test");
  });
});
