import {
  RELEASE_REPOSITORY_URL,
  releaseInstructionsUrl,
  type ReleaseProduct,
  type ReleaseUpdateCandidate,
  type ReleaseUpdateIdentity,
  type ReleaseUpdateMetadata,
} from "./releaseUpdateTypes.js";

const tagPrefixes: Record<ReleaseProduct, string> = {
  vscode: "v",
  desktop: "desktop-v",
  cli: "cli-v",
};
const targets = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "alpine-arm64",
  "alpine-x64",
  "win32-arm64",
  "win32-x64",
]);

export function parseReleaseVersion(value: string): number[] | undefined {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return;
  const parts = value.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) throw new Error("invalid_release_version");
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function releaseVersionFromTag(
  tag: string,
  product: ReleaseProduct,
): string | undefined {
  const prefix = tagPrefixes[product];
  if (typeof tag !== "string" || !tag.startsWith(prefix)) return;
  const version = tag.slice(prefix.length);
  return parseReleaseVersion(version) ? version : undefined;
}

export function expectedReleaseAsset(
  product: ReleaseProduct,
  version: string,
  target: string,
): string | undefined {
  if (!targets.has(target)) return;
  if (product === "vscode") return `agentlink-${version}-${target}.vsix`;
  if (product === "desktop" && target.startsWith("darwin-")) {
    return `AgentLink-Desktop-${version}-mac-${target.slice(7)}.dmg`;
  }
  if (product === "cli" && target === "darwin-arm64") {
    return `agentlink-cli-darwin-arm64-v${version}.tar.gz`;
  }
}

export function parseReleaseUpdateMetadata(
  value: unknown,
  product: ReleaseProduct,
  tag: string,
): ReleaseUpdateMetadata | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.product !== product ||
    value.tag !== tag
  )
    return;
  const version = releaseVersionFromTag(tag, product);
  if (
    !version ||
    value.version !== version ||
    !["stable", "preview"].includes(String(value.channel))
  )
    return;
  if (!isRecord(value.targets) || !isRecord(value.engines)) return;
  if (Object.keys(value.engines).some((key) => key !== "vscode")) return;
  if (
    value.engines.vscode !== undefined &&
    (product !== "vscode" || typeof value.engines.vscode !== "string")
  )
    return;
  if (product === "vscode" && typeof value.engines.vscode !== "string") return;
  const entries = Object.entries(value.targets);
  if (
    !entries.length ||
    entries.length > 8 ||
    entries.some(
      ([target, asset]) =>
        expectedReleaseAsset(product, version, target) !== asset,
    )
  )
    return;
  return {
    schemaVersion: 1,
    product,
    version,
    tag,
    channel: value.channel as ReleaseUpdateMetadata["channel"],
    targets: Object.fromEntries(entries) as Record<string, string>,
    engines:
      value.engines.vscode === undefined
        ? {}
        : { vscode: value.engines.vscode as string },
  };
}

export function satisfiesReleaseEngine(
  version: string,
  range: string,
): boolean {
  const hostVersion = version.replace(/-insider$/, "");
  const current = parseReleaseVersion(hostVersion);
  if (!current || !range.trim()) return false;
  const comparators = range.trim().split(/\s+/);
  return comparators.every((comparator) => {
    const match = /^(\^|~|>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(comparator);
    if (!match || !parseReleaseVersion(match[2])) return false;
    const required = parseReleaseVersion(match[2])!;
    const comparison = compareReleaseVersions(hostVersion, match[2]);
    switch (match[1]) {
      case "^": {
        const upper =
          required[0] > 0
            ? [required[0] + 1, 0, 0]
            : required[1] > 0
              ? [0, required[1] + 1, 0]
              : [0, 0, required[2] + 1];
        return (
          comparison >= 0 &&
          compareReleaseVersions(hostVersion, upper.join(".")) < 0
        );
      }
      case "~":
        return (
          comparison >= 0 &&
          current[0] === required[0] &&
          current[1] === required[1]
        );
      case ">=":
        return comparison >= 0;
      case "<=":
        return comparison <= 0;
      case ">":
        return comparison > 0;
      case "<":
        return comparison < 0;
      default:
        return comparison === 0;
    }
  });
}

export interface ValidatedReleaseRecord {
  metadata: ReleaseUpdateMetadata;
  assets: string[];
  prerelease: boolean;
}

export function compatibleRelease(
  record: ValidatedReleaseRecord,
  identity: ReleaseUpdateIdentity,
): boolean {
  const { metadata } = record;
  if (
    metadata.product !== identity.product ||
    !metadata.targets[identity.target] ||
    !record.assets.includes(metadata.targets[identity.target])
  )
    return false;
  if (identity.product === "vscode") {
    return (
      !record.prerelease &&
      metadata.channel === "stable" &&
      Boolean(
        identity.vscodeVersion &&
        metadata.engines.vscode &&
        satisfiesReleaseEngine(identity.vscodeVersion, metadata.engines.vscode),
      )
    );
  }
  return metadata.channel === (record.prerelease ? "preview" : "stable");
}

export function selectReleaseUpdate(
  records: ValidatedReleaseRecord[],
  identity: ReleaseUpdateIdentity,
): ReleaseUpdateCandidate | null {
  if (!parseReleaseVersion(identity.version)) return null;
  const selected = records
    .filter(
      (record) =>
        compatibleRelease(record, identity) &&
        compareReleaseVersions(record.metadata.version, identity.version) > 0,
    )
    .sort((a, b) =>
      compareReleaseVersions(b.metadata.version, a.metadata.version),
    )[0];
  if (!selected) return null;
  return {
    version: selected.metadata.version,
    tag: selected.metadata.tag,
    channel: selected.metadata.channel,
    target: identity.target,
    releaseUrl: `${RELEASE_REPOSITORY_URL}/releases/tag/${selected.metadata.tag}`,
    instructionsUrl: releaseInstructionsUrl(identity.product),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
