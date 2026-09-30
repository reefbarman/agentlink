import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  buildCliInstallCommand,
  selectStandaloneRelease,
  type StandaloneRelease,
} from "./standaloneReleaseInstall.js";

function release(
  product: "desktop" | "cli",
  arch = "arm64",
): StandaloneRelease {
  const tag = `${product}-v0.2.0`;
  const name =
    product === "desktop"
      ? `AgentLink-Desktop-0.2.0-mac-${arch}.dmg`
      : `agentlink-cli-darwin-${arch}-v0.2.0.tar.gz`;
  return {
    tag_name: tag,
    draft: false,
    assets: [name, ...(product === "cli" ? [`${name}.sha256`] : [])].map(
      (name) => ({
        name,
        browser_download_url: `https://github.com/reefbarman/agentlink/releases/download/${tag}/${name}`,
      }),
    ),
  };
}

describe("standalone release installation", () => {
  it("selects separate preview tags and the matching desktop architecture", () => {
    const releases = [
      release("cli"),
      release("desktop", "x64"),
      release("desktop"),
    ];
    expect(
      selectStandaloneRelease(releases, "desktop", "arm64")?.asset.name,
    ).toBe("AgentLink-Desktop-0.2.0-mac-arm64.dmg");
    expect(selectStandaloneRelease(releases, "cli", "arm64")?.tag).toBe(
      "cli-v0.2.0",
    );
  });

  it("skips drafts, unrelated tags, and CLI releases without checksums", () => {
    const cli = release("cli");
    expect(
      selectStandaloneRelease(
        [
          { ...cli, draft: true },
          { ...cli, tag_name: "v1.23.0" },
          { ...cli, assets: cli.assets.slice(0, 1) },
        ],
        "cli",
        "arm64",
      ),
    ).toBeUndefined();
  });

  it("refuses URLs outside the expected GitHub release", () => {
    const cli = release("cli");
    cli.assets[0].browser_download_url = "https://example.com/archive";
    expect(() => selectStandaloneRelease([cli], "cli", "arm64")).toThrow(
      "unexpected download URL",
    );
  });

  it("refuses unsupported CLI bundles at the script boundary", () => {
    const selected = selectStandaloneRelease(
      [release("cli", "x64")],
      "cli",
      "x64",
    )!;
    expect(() => buildCliInstallCommand(selected)).toThrow("Apple Silicon");
  });

  it("generates valid bash that verifies before extracting and refuses existing launchers", () => {
    const selected = selectStandaloneRelease([release("cli")], "cli", "arm64")!;
    const command = buildCliInstallCommand(selected);
    execFileSync("/bin/bash", ["-n"], { input: command });
    expect(command.indexOf("shasum -a 256 -c -")).toBeLessThan(
      command.indexOf("tar -xzf"),
    );
    expect(command).toContain('[ -L "$bin/agentlink" ]');
    expect(command).toContain(
      'ln -s "$stage/agentlink-cli-darwin-arm64/bin/agentlink"',
    );
    expect(command).not.toContain("xattr");
    expect(command).not.toContain("sudo");
  });
});
