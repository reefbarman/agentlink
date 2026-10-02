import {
  allocateVersion,
  conventionalBump,
  isVersionOnlyChange,
  latestPublishedVersion,
  planRelease,
  resolveUnitBump,
  unitsForPath,
} from "./release-plan.mjs";

import assert from "node:assert/strict";
import test from "node:test";

test("maps shipped paths to the surfaces that package them", () => {
  assert.deepEqual(unitsForPath("apps/cli/src/main.ts").units, ["cli"]);
  assert.deepEqual(unitsForPath("src/agent/AgentSession.ts").units, [
    "vscode",
    "desktop",
  ]);
  assert.deepEqual(unitsForPath("packages/core/src/agentEngine.ts").units, [
    "sdk",
    "vscode",
    "desktop",
    "cli",
  ]);
  assert.deepEqual(unitsForPath("packages/core/README.md").units, ["sdk"]);
  assert.deepEqual(unitsForPath("README.md").units, ["vscode"]);
  assert.deepEqual(unitsForPath("package-lock.json").units, [
    "vscode",
    "desktop",
    "cli",
  ]);
  assert.deepEqual(unitsForPath("scripts/package-vsix.mjs").units, [
    "vscode",
    "desktop",
    "cli",
  ]);
});

test("ignores tests, CI, release bookkeeping, and dev tooling", () => {
  for (const path of [
    "src/agent/AgentSession.test.ts",
    ".github/workflows/ci.yml",
    ".release/last-plan.json",
    "CHANGELOG.md",
    "packages/core/CHANGELOG.md",
    "resources/builtin-skills/documentation/references/release-notes.md",
    "scripts/report-tool-usage-telemetry.mjs",
    "plans/anything.md",
    "DEVELOPMENT.md",
    "why-agentlink.md",
  ]) {
    assert.deepEqual(unitsForPath(path), { units: [], unknown: false }, path);
  }
});

test("conservatively attributes unknown production paths to every app", () => {
  assert.deepEqual(unitsForPath("new-runtime/thing.js"), {
    units: ["vscode", "desktop", "cli"],
    unknown: true,
  });
});

test("derives deterministic floors from Conventional Commits", () => {
  assert.equal(conventionalBump("feat(chat): add jump buttons"), "minor");
  assert.equal(conventionalBump("fix: handle stale cwd"), "patch");
  assert.equal(conventionalBump("chore: bump deps"), "patch");
  assert.equal(conventionalBump("docs: clarify setup"), "none");
  assert.equal(conventionalBump("feat!: remove API"), "breaking");
  assert.equal(
    conventionalBump("fix: tidy", "BREAKING CHANGE: removes export"),
    "breaking",
  );
  assert.equal(conventionalBump("Update things"), "unknown");
});

test("AI can raise but never lower a deterministic floor", () => {
  const commits = [
    { sha: "a".repeat(40), subject: "feat: x" },
    { sha: "b".repeat(40), subject: "fix: y" },
  ];
  assert.equal(
    resolveUnitBump("vscode", commits, { ["a".repeat(40)]: { bump: "none" } })
      .bump,
    "minor",
  );
  assert.equal(
    resolveUnitBump("sdk", commits, {
      ["b".repeat(40)]: { bump: "patch", breakingUnits: ["sdk"] },
    }).bump,
    "breaking",
  );
});

test("non-conventional commits stay unclassified without an AI decision", () => {
  const sha = "c".repeat(40);
  const commits = [{ sha, subject: "Misc changes" }];
  assert.deepEqual(resolveUnitBump("cli", commits).unclassified, [sha]);
  assert.equal(
    resolveUnitBump("cli", commits, { [sha]: { bump: "minor" } }).bump,
    "minor",
  );
});

test("reuses a local VS Code reservation that already satisfies the bump", () => {
  assert.deepEqual(
    allocateVersion({
      published: "1.23.0",
      reserved: "1.23.21",
      bump: "patch",
    }),
    {
      status: "release",
      version: "1.23.21",
      effectiveBump: "patch",
      breaking: false,
      usedReservation: true,
      consumedIntent: false,
    },
  );
  assert.equal(
    allocateVersion({ published: "1.23.0", reserved: "1.23.21", bump: "minor" })
      .version,
    "1.24.0",
  );
  assert.equal(
    allocateVersion({ published: "1.23.0", reserved: "1.24.3", bump: "minor" })
      .version,
    "1.24.3",
  );
});

test("does not release metadata-only version bumps", () => {
  assert.equal(
    allocateVersion({ published: "1.23.0", reserved: "1.23.21", bump: "none" })
      .status,
    "skip",
  );
});

test("maps 0.x breaking changes to a minor release", () => {
  const result = allocateVersion({
    published: "0.3.0",
    reserved: "0.3.0",
    bump: "breaking",
  });
  assert.equal(result.version, "0.4.0");
  assert.equal(result.breaking, true);
});

test("holds 1.x breaking changes and unapproved major reservations", () => {
  assert.equal(
    allocateVersion({
      published: "1.23.0",
      reserved: "1.23.0",
      bump: "breaking",
    }).status,
    "hold",
  );
  assert.equal(
    allocateVersion({ published: "1.23.0", reserved: "2.0.0", bump: "patch" })
      .status,
    "hold",
  );
  assert.equal(
    allocateVersion({ published: "0.2.0", reserved: "1.0.0", bump: "minor" })
      .status,
    "hold",
  );
});

test("an explicit intent is the only way across a major boundary", () => {
  const result = allocateVersion({
    published: "1.23.0",
    reserved: "2.0.0",
    bump: "breaking",
    intent: "2.0.0",
  });
  assert.equal(result.status, "release");
  assert.equal(result.version, "2.0.0");
  assert.equal(result.consumedIntent, true);
  assert.equal(
    allocateVersion({
      published: "2.0.0",
      reserved: "2.0.0",
      bump: "patch",
      intent: "2.0.0",
    }).version,
    "2.0.1",
    "a stale, already-published intent is ignored",
  );
});

test("rejects manifest downgrades", () => {
  assert.equal(
    allocateVersion({ published: "1.23.0", reserved: "1.22.9", bump: "patch" })
      .status,
    "hold",
  );
});

test("selects the highest published version for each tag stream", () => {
  const tags = [
    "v1.23.0",
    "v1.22.78",
    "desktop-v0.2.0",
    "cli-v0.2.0",
    "v1.9.9",
  ];
  assert.equal(latestPublishedVersion(tags, "v"), "1.23.0");
  assert.equal(latestPublishedVersion(tags, "desktop-v"), "0.2.0");
  assert.equal(latestPublishedVersion(tags, "sdk-v"), undefined);
});

test("plans independent units and holds the SDK bootstrap without intent", () => {
  const commits = [
    { sha: "1".repeat(40), subject: "feat(chat): jump", files: ["src/a.ts"] },
    {
      sha: "2".repeat(40),
      subject: "fix(core): x",
      files: ["packages/core/src/x.ts"],
    },
    {
      sha: "3".repeat(40),
      subject: "ci: y",
      files: [".github/workflows/a.yml"],
    },
  ];
  const plan = planRelease({
    units: {
      vscode: { published: "1.23.0", reserved: "1.23.21", commits },
      cli: { published: "0.2.0", reserved: "0.2.0", commits },
      sdk: {
        published: "0.2.0",
        reserved: "0.2.0",
        bootstrap: true,
        commits,
      },
    },
  });
  assert.equal(plan.vscode.version, "1.24.0");
  assert.equal(plan.cli.version, "0.2.1");
  assert.deepEqual(plan.cli.commits, ["2".repeat(40)]);
  assert.equal(plan.sdk.status, "hold");
  assert.match(plan.sdk.reason, /intents\/sdk\.json/u);
});

test("an SDK intent releases the first matched SDK version", () => {
  const plan = planRelease({
    units: {
      sdk: {
        published: "0.2.0",
        reserved: "0.2.0",
        bootstrap: true,
        intent: "0.3.0",
        commits: [
          { sha: "4".repeat(40), subject: "fix: y", files: ["packages/x.ts"] },
        ],
      },
    },
  });
  assert.equal(plan.sdk.status, "release");
  assert.equal(plan.sdk.version, "0.3.0");
});

test("treats version and workspace pin edits as release bookkeeping", () => {
  const manifest = (version, core, extra = {}) =>
    JSON.stringify({
      name: "agentlink",
      version,
      dependencies: { "@agentlink/core": core, zod: "^4.0.0", ...extra },
    });
  assert.equal(
    isVersionOnlyChange(
      "package.json",
      manifest("1.23.20", "0.2.0"),
      manifest("1.23.21", "0.3.0"),
    ),
    true,
  );
  assert.equal(
    isVersionOnlyChange(
      "package.json",
      manifest("1.23.20", "0.2.0"),
      manifest("1.23.21", "0.2.0", { diff: "^9.0.0" }),
    ),
    false,
    "a new external dependency ships",
  );
  const lock = (version, zod) =>
    JSON.stringify({
      version,
      packages: {
        "": { version, dependencies: { "@agentlink/core": version } },
        "packages/core": { version: "0.2.0" },
        "node_modules/zod": { version: zod },
      },
    });
  assert.equal(
    isVersionOnlyChange(
      "package-lock.json",
      lock("1.0.0", "4.0.0"),
      lock("1.0.1", "4.0.0"),
    ),
    true,
  );
  assert.equal(
    isVersionOnlyChange(
      "package-lock.json",
      lock("1.0.0", "4.0.0"),
      lock("1.0.1", "4.1.0"),
    ),
    false,
    "an external dependency upgrade ships",
  );
  assert.equal(isVersionOnlyChange("src/a.json", "{}", "{}"), false);
});

test("a VS Code-only release does not cascade into other surfaces", () => {
  // Preparation commits only touch normalized-away manifest fields and
  // release bookkeeping, so the coordinator passes them with no files.
  const plan = planRelease({
    units: {
      desktop: {
        published: "0.2.0",
        reserved: "0.2.0",
        commits: [
          {
            sha: "5".repeat(40),
            subject: "chore(release): vscode v1.24.0",
            files: [],
          },
        ],
      },
    },
  });
  assert.equal(plan.desktop.status, "skip");
});
