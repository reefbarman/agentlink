// Pure release-planning rules shared by the release coordinator and its tests.
// Nothing here touches Git, the network, or the filesystem.

export const RELEASE_UNITS = {
  vscode: {
    title: "AgentLink",
    tagPrefix: "v",
    manifests: ["package.json"],
    changelog: "CHANGELOG.md",
    prerelease: false,
    makeLatest: true,
  },
  desktop: {
    title: "AgentLink Desktop",
    tagPrefix: "desktop-v",
    manifests: ["apps/desktop/package.json"],
    prerelease: true,
    makeLatest: false,
  },
  cli: {
    title: "AgentLink CLI",
    tagPrefix: "cli-v",
    manifests: ["apps/cli/package.json"],
    prerelease: true,
    makeLatest: false,
  },
  sdk: {
    title: "AgentLink SDK",
    tagPrefix: "sdk-v",
    // One matched version for every library workspace.
    manifests: [
      "packages/protocol/package.json",
      "packages/core/package.json",
      "packages/node-host/package.json",
      "packages/workspace-host/package.json",
    ],
    changelog: "packages/core/CHANGELOG.md",
    prerelease: true,
    makeLatest: false,
  },
};

export const UNIT_IDS = Object.keys(RELEASE_UNITS);
const APPS = ["vscode", "desktop", "cli"];

// Release bookkeeping, tests, CI, and contributor-only material never release
// a product by themselves.
const IGNORED_PATHS = [
  /(^|\/)[^/]+\.test\.[cm]?[jt]sx?$/,
  /(^|\/)__tests__\//,
  /(^|\/)vitest\.config\.[cm]?[jt]s$/,
  /(^|\/)CHANGELOG\.md$/,
  /^\.release\//,
  /^\.github\//,
  /^\.(agentlink|claude|agents|vscode)\//,
  /^plans\//,
  /^fixtures\//,
  /^benchmarks\//,
  /^telemetry-reports\//,
  // Root Markdown is contributor/positioning material; README.md ships in the VSIX.
  /^(?!README\.md$)[^/]+\.md$/,
  /^\.(gitignore|oxfmtrc\.json|oxlintrc\.json|editorconfig|npmrc)$/,
  /^resources\/builtin-skills\/documentation\/references\/release-notes\.md$/,
  /^apps\/[^/]+\/(smoke-[^/]+|vitest\.config\.[^/]+)$/,
];

// Build tooling that changes what ships. Other scripts are development tools.
const PACKAGING_SCRIPTS =
  /^scripts\/(package-[^/]+|sandbox-[^/]+|macos-signing|generate-documentation-package-contract|generate-tool-inventory)\.mjs$/;

// Ordered: the first matching rule wins.
const PATH_RULES = [
  [/^apps\/desktop\//, ["desktop"]],
  [/^apps\/cli\//, ["cli"]],
  [/^packages\/[^/]+\/README\.md$/, ["sdk"]],
  [/^packages\//, ["sdk", ...APPS]],
  [/^(src|resources|media)\//, ["vscode", "desktop"]],
  [/^esbuild\.mjs$/, ["vscode", "desktop"]],
  [/^(\.vscodeignore|README\.md|LICENSE)$/, ["vscode"]],
  [/^package(-lock)?\.json$/, APPS],
  [PACKAGING_SCRIPTS, APPS],
  [/^scripts\//, []],
  [/^tsconfig[^/]*\.json$/, APPS],
];

/**
 * Returns the release units a changed path ships in. Unknown paths are
 * conservatively attributed to every app rather than silently skipped.
 */
export function unitsForPath(path) {
  if (IGNORED_PATHS.some((pattern) => pattern.test(path))) {
    return { units: [], unknown: false };
  }
  for (const [pattern, units] of PATH_RULES) {
    if (pattern.test(path)) return { units: [...units], unknown: false };
  }
  return { units: [...APPS], unknown: true };
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function maskWorkspacePins(entry) {
  if (!entry || typeof entry !== "object") return;
  delete entry.version;
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(entry[field] ?? {})) {
      if (name.startsWith("@agentlink/")) entry[field][name] = "*";
    }
  }
}

function normalizeVersionBookkeeping(path, text) {
  const value = JSON.parse(text);
  if (path === "package-lock.json") {
    delete value.version;
    for (const [key, entry] of Object.entries(value.packages ?? {})) {
      if (key === "" || /^(packages|apps)\/[^/]+$/u.test(key)) {
        maskWorkspacePins(entry);
      }
    }
  } else maskWorkspacePins(value);
  return JSON.stringify(value);
}

/**
 * True when a manifest or lockfile change only touches release bookkeeping:
 * workspace versions and exact `@agentlink/*` pins. Such changes come from
 * release preparation or local dogfood bumps and must not trigger releases.
 */
export function isVersionOnlyChange(path, before, after) {
  if (
    !/^((apps|packages)\/[^/]+\/)?package\.json$|^package-lock\.json$/u.test(
      path,
    )
  ) {
    return false;
  }
  if (before === undefined || after === undefined) return false;
  try {
    return (
      normalizeVersionBookkeeping(path, before) ===
      normalizeVersionBookkeeping(path, after)
    );
  } catch {
    return false;
  }
}

export const BUMP_ORDER = ["none", "patch", "minor", "breaking"];

export function maxBump(...bumps) {
  return bumps.reduce(
    (current, bump) =>
      BUMP_ORDER.indexOf(bump) > BUMP_ORDER.indexOf(current) ? bump : current,
    "none",
  );
}

const NO_RELEASE_TYPES = new Set(["docs", "test", "ci", "style"]);

/**
 * Deterministic Conventional Commit floor. Returns `unknown` for messages
 * that do not follow the convention; those need AI or explicit classification.
 */
export function conventionalBump(subject, body = "") {
  const match = /^(\w+)(\([^)]*\))?(!)?:\s/u.exec(subject);
  if (!match) return "unknown";
  if (match[3] || /^BREAKING[ -]CHANGE:/mu.test(body)) return "breaking";
  const type = match[1].toLowerCase();
  if (type === "feat") return "minor";
  if (NO_RELEASE_TYPES.has(type)) return "none";
  return "patch";
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;

export function parseVersion(version) {
  const match = SEMVER.exec(version ?? "");
  if (!match) throw new Error(`Invalid release version: ${version}`);
  return match.slice(1).map(Number);
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

const maxVersion = (a, b) => (compareVersions(a, b) >= 0 ? a : b);

export function incrementVersion(version, bump) {
  const [major, minor, patch] = parseVersion(version);
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "major") return `${major + 1}.0.0`;
  throw new Error(`Unsupported increment: ${bump}`);
}

/** Highest published `prefix + X.Y.Z` tag, or undefined. */
export function latestPublishedVersion(tags, tagPrefix) {
  // Tag prefixes are fixed lowercase literals (`v`, `desktop-v`, ...).
  const pattern = new RegExp(`^${tagPrefix}(\\d+\\.\\d+\\.\\d+)$`, "u");
  let latest;
  for (const tag of tags) {
    const version = pattern.exec(tag)?.[1];
    if (version && (!latest || compareVersions(version, latest) > 0)) {
      latest = version;
    }
  }
  return latest;
}

/**
 * Combines per-commit floors and optional AI decisions into one unit bump.
 * AI can raise a deterministic floor, never lower it.
 */
export function resolveUnitBump(unitId, commits, decisions = {}) {
  let bump = "none";
  const unclassified = [];
  const breaking = [];
  for (const commit of commits) {
    const floor = conventionalBump(commit.subject, commit.body);
    const decision = decisions[commit.sha];
    const aiBump = decision
      ? decision.breakingUnits?.includes(unitId)
        ? "breaking"
        : decision.bump
      : undefined;
    if (floor === "unknown" && !aiBump) {
      unclassified.push(commit.sha);
      continue;
    }
    const commitBump = maxBump(
      floor === "unknown" ? "none" : floor,
      aiBump ?? "none",
    );
    if (commitBump === "breaking") breaking.push(commit.sha);
    bump = maxBump(bump, commitBump);
  }
  return { bump, unclassified, breaking };
}

/**
 * Allocates the next version for one unit.
 *
 * - `published`: last complete public release (the semantic baseline).
 * - `reserved`: version already committed in the manifest, e.g. by a local
 *   VS Code dogfood bump. It is reused when it already satisfies the bump.
 * - `intent`: explicit maintainer target from `.release/intents/<unit>.json`.
 *   It is the only way to cross a major boundary.
 */
export function allocateVersion({ published, reserved, bump, intent }) {
  if (bump === "none") return { status: "skip", reason: "no shipped changes" };
  if (compareVersions(reserved, published) < 0) {
    return {
      status: "hold",
      reason: `manifest version ${reserved} is lower than published ${published}`,
    };
  }
  const [publishedMajor] = parseVersion(published);
  let effective = bump;
  if (bump === "breaking") {
    if (publishedMajor === 0) effective = "minor";
    else if (!intent || parseVersion(intent)[0] <= publishedMajor) {
      return {
        status: "hold",
        reason:
          "breaking change detected; add a major intent or rework the change",
      };
    } else effective = "minor";
  }
  let version = maxVersion(incrementVersion(published, effective), reserved);
  const activeIntent =
    intent && compareVersions(intent, published) > 0 ? intent : undefined;
  if (activeIntent) version = maxVersion(version, activeIntent);
  if (
    parseVersion(version)[0] > publishedMajor &&
    !(activeIntent && compareVersions(version, activeIntent) === 0)
  ) {
    return {
      status: "hold",
      reason: `version ${version} crosses a major boundary without an explicit intent`,
    };
  }
  return {
    status: "release",
    version,
    effectiveBump: effective,
    breaking: bump === "breaking",
    usedReservation: compareVersions(version, reserved) === 0,
    consumedIntent: Boolean(activeIntent),
  };
}

/**
 * Plans all units from already-collected repository facts.
 *
 * `units[id]` supplies `{ published, baselineRef, reserved, intent,
 * bootstrap, commits }`, where commits are the non-merge commits since that
 * unit's baseline with release-irrelevant file changes already normalized
 * away (`files`).
 */
export function planRelease({ units, decisions = {} }) {
  const result = {};
  for (const id of UNIT_IDS) {
    const facts = units[id];
    if (!facts) continue;
    const relevant = [];
    let unknownPaths = [];
    for (const commit of facts.commits) {
      let affects = false;
      for (const file of commit.files) {
        const owner = unitsForPath(file);
        if (owner.units.includes(id)) {
          affects = true;
          if (owner.unknown) unknownPaths.push(file);
        }
      }
      if (affects) relevant.push(commit);
    }
    unknownPaths = [...new Set(unknownPaths)].sort();
    const { bump, unclassified, breaking } = resolveUnitBump(
      id,
      relevant,
      decisions,
    );
    const base = {
      published: facts.published,
      baselineRef: facts.baselineRef,
      reserved: facts.reserved,
      commits: relevant.map((commit) => commit.sha),
      unknownPaths,
      breakingCommits: breaking,
    };
    if (unclassified.length > 0) {
      result[id] = {
        ...base,
        status: "hold",
        reason: `unclassified commits need AI or explicit classification: ${unclassified.map((sha) => sha.slice(0, 8)).join(", ")}`,
      };
      continue;
    }
    if (facts.bootstrap && bump !== "none" && !facts.intent) {
      result[id] = {
        ...base,
        status: "hold",
        reason: `first ${id} release needs an explicit intent (.release/intents/${id}.json)`,
      };
      continue;
    }
    result[id] = {
      ...base,
      bump,
      ...allocateVersion({
        published: facts.published,
        reserved: facts.reserved,
        bump,
        intent: facts.intent,
      }),
    };
  }
  return result;
}
