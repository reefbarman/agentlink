# Release automation

AgentLink ships four independently versioned release streams from `main`:

| Unit      | Tag              | Version source                                       | Release                               |
| --------- | ---------------- | ---------------------------------------------------- | ------------------------------------- |
| `vscode`  | `vX.Y.Z`         | `package.json`                                       | Latest, 8 target VSIXs                |
| `desktop` | `desktop-vX.Y.Z` | `apps/desktop/package.json`                          | Prerelease, mac arm64/x64 DMG and ZIP |
| `cli`     | `cli-vX.Y.Z`     | `apps/cli/package.json`                              | Prerelease, mac arm64 archive         |
| `sdk`     | `sdk-vX.Y.Z`     | every `packages/*/package.json`, one matched version | Prerelease, protocol/core/node-host   |

Unit membership by path lives in `scripts/release-plan.mjs` (`RELEASE_UNITS`, `unitsForPath`).

## How a release is planned

After CI passes on a push to `main`, `.github/workflows/release-coordinator.yml` runs `node scripts/release-coordinator.mjs plan`:

1. For each unit, collect non-merge commits that touch its paths since its newest published tag.
2. Classify each commit as `none`, `patch`, `minor`, or `major`. Conventional Commit prefixes give the floor; with `OPENROUTER_API_KEY` set, an AI classifier (`scripts/release-classify.mjs`) reads the bounded diff and can raise it. The AI never lowers a conventional bump. A commit with no Conventional prefix holds its unit until the classifier runs, and then ships at least a patch, so commit text cannot talk the model into skipping a release.
3. Allocate a version with `allocateVersion`:
   - 0.x units turn breaking changes into a minor, with a note.
   - 1.x+ units never cross a major boundary without an explicit intent file.
   - A higher manifest version that is still unpublished (a local reservation) is reused rather than skipped.
4. Write the plan to the job summary and the `release-plan` artifact.

Publication only happens when the repository variable `RELEASE_AUTOMATION` is `publish`, or when the workflow is dispatched manually with `mode=publish`. In that case the `prepare` job applies versions, SDK pins, and changelog entries, then fast-forwards `main` with a `chore(release): ...` commit. The per-unit workflows build that exact SHA and publish through `scripts/release-publish.mjs`: upload to a draft with `SHA256SUMS`, check the exact asset set against GitHub's SHA-256 digests, then publish. Each unit's publish job is serialized by a concurrency group.

If a package or publish job fails after `prepare` pushed, the next passing push replans the same version: the manifest version is reused, the changelog section is kept rather than duplicated, and intent files are only removed once their version is published.

Pushes and tags made with `GITHUB_TOKEN` do not start other workflows, so the release commit does not re-trigger CI or the coordinator. The tag-triggered paths in the per-unit workflows only run for tags a maintainer pushes by hand.

## Local version bumps (`npm run release`)

Only the VS Code extension version is bumped locally:

- `npm run release -- --install` makes a patch bump. Commit it with the work as usual; the coordinator treats it as a reservation and either uses it or raises it to a minor.
- `--minor` or `--major` also writes `intents/vscode.json`. Commit that file to make the target explicit. A major intent is the only way to publish a new VS Code major.

Desktop, CLI, and SDK local builds never change their versions.

## Intent files

`intents/<unit>.json` contains `{ "version": "X.Y.Z" }`. The coordinator publishes at least that version. A later release commit removes the file once that version is published. Intents are required for:

- any major release of a 1.x+ unit;
- the first release of a unit with no published tag (see `sdk-bootstrap.json`; the first SDK release needs `intents/sdk.json`).

## Overriding a classification

When the classifier gets a commit wrong (for example, it calls an agent-facing tool consolidation breaking), record the maintainer decision in `overrides.json`, keyed by the full commit SHA:

```json
{
  "commits": {
    "<full sha>": {
      "bump": "minor",
      "breakingUnits": [],
      "reason": "Why this is the right call."
    }
  }
}
```

An override replaces the AI's bump and breaking units for that commit and keeps its summary. It cannot go below the Conventional Commit prefix, so a `feat:` stays at least a minor and a commit without a prefix still ships a patch. The plan summary lists the overrides it applied. To ship a genuinely breaking change in a 1.x+ unit, add an intent file instead.

## Repository configuration

| Kind     | Name                        | Purpose                                                              |
| -------- | --------------------------- | -------------------------------------------------------------------- |
| Secret   | `OPENROUTER_API_KEY`        | Enables AI classification; without it only commit prefixes count     |
| Variable | `RELEASE_AI_MODEL`          | Overrides the default classifier model                               |
| Variable | `RELEASE_AI_FALLBACK_MODEL` | Model used when the primary fails                                    |
| Variable | `RELEASE_AUTOMATION`        | `publish` to release on every passing push; anything else plans only |
| Setting  | Immutable releases          | Required before publishing: locks published assets and their tags    |

Enable immutable releases (Settings → General → Releases, or `gh api -X PUT repos/reefbarman/agentlink/immutable-releases`) before the first automated publish. The publish helper never edits a published release, but only this setting stops a later asset edit or tag move from someone else. It applies to releases published after it is turned on.

Preview a plan locally with `npm run release:plan` (add `-- --classify` with `OPENROUTER_API_KEY` exported).
