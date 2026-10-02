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
2. Classify each commit as `none`, `patch`, `minor`, or `major`. Conventional Commit prefixes give the floor; with `OPENROUTER_API_KEY` set, an AI classifier (`scripts/release-classify.mjs`) reads the bounded diff and can raise it. The AI never lowers a conventional bump. Without the classifier, a commit with no Conventional prefix holds its unit until it is classified.
3. Allocate a version with `allocateVersion`:
   - 0.x units turn breaking changes into a minor, with a note.
   - 1.x+ units never cross a major boundary without an explicit intent file.
   - A higher manifest version that is still unpublished (a local reservation) is reused rather than skipped.
4. Write the plan to the job summary and the `release-plan` artifact.

Publication only happens when the repository variable `RELEASE_AUTOMATION` is `publish`, or when the workflow is dispatched manually with `mode=publish`. In that case the `prepare` job applies versions, SDK pins, and changelog entries, then fast-forwards `main` with a `chore(release): ...` commit. The per-unit workflows build that exact SHA and publish through `scripts/release-publish.mjs` (draft, `SHA256SUMS`, then publish; published releases are immutable).

Pushes and tags made with `GITHUB_TOKEN` do not start other workflows, so the release commit does not re-trigger CI or the coordinator. The tag-triggered paths in the per-unit workflows only run for tags a maintainer pushes by hand.

## Local version bumps (`npm run release`)

Only the VS Code extension version is bumped locally:

- `npm run release -- --install` makes a patch bump. Commit it with the work as usual; the coordinator treats it as a reservation and either uses it or raises it to a minor.
- `--minor` or `--major` also writes `intents/vscode.json`. Commit that file to make the target explicit. A major intent is the only way to publish a new VS Code major.

Desktop, CLI, and SDK local builds never change their versions.

## Intent files

`intents/<unit>.json` contains `{ "version": "X.Y.Z" }`. The coordinator publishes at least that version and deletes the file in the release commit. Intents are required for:

- any major release of a 1.x+ unit;
- the first release of a unit with no published tag (see `sdk-bootstrap.json`; the first SDK release needs `intents/sdk.json`).

## Repository configuration

| Kind     | Name                        | Purpose                                                              |
| -------- | --------------------------- | -------------------------------------------------------------------- |
| Secret   | `OPENROUTER_API_KEY`        | Enables AI classification; without it only commit prefixes count     |
| Variable | `RELEASE_AI_MODEL`          | Overrides the default classifier model                               |
| Variable | `RELEASE_AI_FALLBACK_MODEL` | Model used when the primary fails                                    |
| Variable | `RELEASE_AUTOMATION`        | `publish` to release on every passing push; anything else plans only |

Preview a plan locally with `npm run release:plan` (add `-- --classify` with `OPENROUTER_API_KEY` exported).
