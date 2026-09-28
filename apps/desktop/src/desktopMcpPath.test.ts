import { describe, expect, it, vi } from "vitest";

import { resolveDesktopMcpPath } from "./desktopMcpPath.js";

describe("resolveDesktopMcpPath", () => {
  it("uses the login shell PATH for GUI-launched macOS Desktop MCP servers", async () => {
    const runShell = vi.fn(async () => ({
      stdout:
        "shell greeting\n__AGENTLINK_DESKTOP_SHELL_PATH__/Users/test/.local/share/mise/shims:/usr/bin\n",
      stderr: "",
    }));
    const environment = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" };

    expect(await resolveDesktopMcpPath(environment, runShell, "darwin")).toBe(
      "/Users/test/.local/share/mise/shims:/usr/bin",
    );
    expect(runShell).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-lic", expect.stringContaining("__AGENTLINK_DESKTOP_SHELL_PATH__")],
      { env: environment, timeout: 3_000, maxBuffer: 64 * 1024 },
    );
  });

  it("retains the inherited PATH if shell startup fails or produces no PATH", async () => {
    const environment = { PATH: "/usr/bin:/bin", SHELL: "/missing/shell" };
    expect(
      await resolveDesktopMcpPath(
        environment,
        vi.fn(async () => {
          throw new Error("shell failed");
        }),
        "darwin",
      ),
    ).toBe(environment.PATH);
    expect(
      await resolveDesktopMcpPath(
        environment,
        vi.fn(async () => ({ stdout: "shell greeting", stderr: "" })),
        "darwin",
      ),
    ).toBe(environment.PATH);
  });

  it("does not run a shell on other platforms", async () => {
    const runShell = vi.fn();
    expect(
      await resolveDesktopMcpPath({ PATH: "/usr/bin" }, runShell, "linux"),
    ).toBe("/usr/bin");
    expect(runShell).not.toHaveBeenCalled();
  });
});
