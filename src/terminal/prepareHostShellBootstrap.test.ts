import { describe, expect, it } from "vitest";

import type { VscodeTerminalConfigurationSnapshot } from "./vscodeTerminalProfileAdapter.js";
import { prepareHostShellBootstrap } from "./prepareHostShellBootstrap.js";

function configuration(
  shellPath: string,
  shellArgs: string[] = [],
  overrides: Partial<VscodeTerminalConfigurationSnapshot> = {},
): VscodeTerminalConfigurationSnapshot {
  return {
    isWorkspaceTrusted: true,
    platform: "darwin",
    defaultProfile: { globalValue: "Selected" },
    profiles: {
      globalValue: { Selected: { path: shellPath, args: shellArgs } },
    },
    environment: {},
    baseEnvironment: { HOME: "/Users/test" },
    fallbackShellPath: "/bin/zsh",
    homeDirectory: "/Users/test",
    workspaceDirectories: ["/workspace"],
    ...overrides,
  };
}

function prepare(config: VscodeTerminalConfigurationSnapshot) {
  return prepareHostShellBootstrap({
    configuration: config,
    host: { platform: "darwin" },
    runtimeRoot: "/extension-storage/terminal-bootstrap",
    artifactId: "session-1",
    nonce: "prepare_nonce_123456",
  });
}

describe("prepareHostShellBootstrap", () => {
  it("returns native fallback before launch policy for unsafe configuration", () => {
    const prepared = prepare(
      configuration("/bin/zsh", ["${workspaceFolder}"], {
        isWorkspaceTrusted: false,
      }),
    );

    expect(prepared.plan).toMatchObject({
      mode: "native-fallback",
      reason: "terminal-configuration-unsafe",
    });
  });

  it.each([
    ["bash login", "/bin/bash", ["-l"], "unsupported-bash-arguments"],
    ["bash command", "/bin/bash", ["-c", "echo"], "unsupported-bash-arguments"],
    ["zsh command", "/bin/zsh", ["-c", "echo"], "unsupported-zsh-arguments"],
  ])(
    "returns native fallback after bootstrap rejects %s",
    (_name, shellPath, shellArgs, reason) => {
      expect(prepare(configuration(shellPath, shellArgs)).plan).toMatchObject({
        mode: "native-fallback",
        reason,
      });
    },
  );

  it("preserves native shell and unsupported-host fallback", () => {
    expect(prepare(configuration("/opt/homebrew/bin/fish")).plan).toMatchObject(
      {
        mode: "native-fallback",
        reason: "native-shell-required",
      },
    );
    expect(
      prepareHostShellBootstrap({
        configuration: configuration("/bin/zsh"),
        host: { platform: "linux" },
        runtimeRoot: "/extension-storage/terminal-bootstrap",
        artifactId: "session-1",
        nonce: "prepare_nonce_123456",
      }).plan,
    ).toMatchObject({ mode: "native-fallback", reason: "host-unsupported" });
  });

  it("returns inert integrated and raw plans for supported profiles", () => {
    expect(prepare(configuration("/bin/zsh", ["-l"])).plan).toMatchObject({
      mode: "integrated",
      shell: "zsh",
      profile: { shellArgs: ["-l", "-i"] },
    });
    expect(prepare(configuration("/bin/sh")).plan).toMatchObject({
      mode: "raw",
      profile: { shellPath: "/bin/sh" },
    });
  });
});
