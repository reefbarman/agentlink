import { describe, expect, it } from "vitest";
import {
  compareReleaseVersions,
  parseReleaseUpdateMetadata,
  releaseVersionFromTag,
  satisfiesReleaseEngine,
  selectReleaseUpdate,
  type ValidatedReleaseRecord,
} from "./releaseSelection.js";
import type { ReleaseUpdateIdentity } from "./releaseUpdateTypes.js";

const identity: ReleaseUpdateIdentity = {
  product: "vscode",
  version: "1.9.0",
  target: "linux-x64",
  vscodeVersion: "1.110.0",
  development: false,
};
function record(
  version = "1.10.0",
  engine = "^1.109.0",
): ValidatedReleaseRecord {
  return {
    metadata: {
      schemaVersion: 1,
      product: "vscode",
      version,
      tag: `v${version}`,
      channel: "stable",
      targets: { "linux-x64": `agentlink-${version}-linux-x64.vsix` },
      engines: { vscode: engine },
    },
    assets: [`agentlink-${version}-linux-x64.vsix`],
    prerelease: false,
  };
}

describe("release selection", () => {
  it("compares numeric versions and isolates product tags", () => {
    expect(compareReleaseVersions("1.10.0", "1.9.0")).toBe(1);
    expect(releaseVersionFromTag("desktop-v0.3.0", "vscode")).toBeUndefined();
    expect(releaseVersionFromTag("sdk-v0.3.0", "cli")).toBeUndefined();
    expect(releaseVersionFromTag("cli-v0.3.0-beta", "cli")).toBeUndefined();
  });
  it("rejects unknown engine formats without guessing compatibility", () => {
    expect(satisfiesReleaseEngine("1.110.0", "^1.109.0")).toBe(true);
    expect(satisfiesReleaseEngine("1.110.0-insider", "^1.109.0")).toBe(true);
    expect(satisfiesReleaseEngine("1.108.0-insider", "^1.109.0")).toBe(false);
    expect(satisfiesReleaseEngine("2.0.0", "^1.109.0")).toBe(false);
    expect(satisfiesReleaseEngine("0.3.1", "^0.3.0")).toBe(true);
    expect(satisfiesReleaseEngine("0.4.0", "^0.3.0")).toBe(false);
    expect(satisfiesReleaseEngine("1.110.0", ">=1.109.0 <2.0.0")).toBe(true);
    expect(satisfiesReleaseEngine("1.110.0", "*")).toBe(false);
  });
  it("selects only newer target/runtime-compatible records", () => {
    expect(
      selectReleaseUpdate([record("1.11.0", "^1.120.0"), record()], identity)
        ?.version,
    ).toBe("1.10.0");
    expect(
      selectReleaseUpdate([record()], { ...identity, target: "alpine-x64" }),
    ).toBeNull();
    expect(
      selectReleaseUpdate([record()], { ...identity, version: "1.10.0" }),
    ).toBeNull();
    expect(
      selectReleaseUpdate([record()], { ...identity, version: "2.0.0" }),
    ).toBeNull();
    expect(
      selectReleaseUpdate([{ ...record(), prerelease: true }], identity),
    ).toBeNull();
    expect(
      selectReleaseUpdate([{ ...record(), assets: [] }], identity),
    ).toBeNull();
  });
  it("accepts standalone preview releases and derives trusted links", () => {
    const release: ValidatedReleaseRecord = {
      metadata: {
        schemaVersion: 1,
        product: "desktop",
        version: "0.4.0",
        tag: "desktop-v0.4.0",
        channel: "preview",
        targets: { "darwin-arm64": "AgentLink-Desktop-0.4.0-mac-arm64.dmg" },
        engines: {},
      },
      assets: ["AgentLink-Desktop-0.4.0-mac-arm64.dmg"],
      prerelease: true,
    };
    expect(
      selectReleaseUpdate([release], {
        product: "desktop",
        version: "0.3.0",
        target: "darwin-arm64",
        development: false,
      })?.releaseUrl,
    ).toBe(
      "https://github.com/reefbarman/agentlink/releases/tag/desktop-v0.4.0",
    );
  });
  it("validates metadata product, version, targets and requirements", () => {
    const metadata = record().metadata;
    expect(
      parseReleaseUpdateMetadata(metadata, "vscode", metadata.tag),
    ).toEqual(metadata);
    expect(
      parseReleaseUpdateMetadata(
        { ...metadata, version: "9.0.0" },
        "vscode",
        metadata.tag,
      ),
    ).toBeUndefined();
    expect(
      parseReleaseUpdateMetadata(
        { ...metadata, targets: { "linux-x64": "../payload" } },
        "vscode",
        metadata.tag,
      ),
    ).toBeUndefined();
    expect(
      parseReleaseUpdateMetadata(
        { ...metadata, engines: { unknown: "*" } },
        "vscode",
        metadata.tag,
      ),
    ).toBeUndefined();
  });
});
