import {
  CUSTOM_TERMINAL_AVAILABLE_CONTEXT_KEY,
  CUSTOM_TERMINAL_SUPPORTED_CONTEXT_KEY,
  isCustomTerminalSupported,
} from "./customTerminalSupport.js";
import { describe, expect, it } from "vitest";

describe("custom terminal support", () => {
  it("uses stable support and availability context keys", () => {
    expect(CUSTOM_TERMINAL_SUPPORTED_CONTEXT_KEY).toBe(
      "agentLink.customTerminalSupported",
    );
    expect(CUSTOM_TERMINAL_AVAILABLE_CONTEXT_KEY).toBe(
      "agentLink.customTerminalAvailable",
    );
  });

  it("supports a local Darwin extension host", () => {
    expect(
      isCustomTerminalSupported({ platform: "darwin", remoteName: undefined }),
    ).toBe(true);
  });

  it.each(["linux", "win32", "freebsd"])(
    "falls back on a local %s extension host",
    (platform: string) => {
      expect(isCustomTerminalSupported({ platform })).toBe(false);
    },
  );

  it.each(["wsl", "ssh-remote", "dev-container", "codespaces"])(
    "falls back in a %s remote window even when the extension host reports Darwin",
    (remoteName: string) => {
      expect(
        isCustomTerminalSupported({ platform: "darwin", remoteName }),
      ).toBe(false);
    },
  );

  it("treats an empty remote name as local", () => {
    expect(
      isCustomTerminalSupported({ platform: "darwin", remoteName: "" }),
    ).toBe(true);
  });
});
