---
name: dogfood-feature-defaults
description: Decide default-on vs opt-in and breaking-change handling for new AgentLink features, settings, and behavior changes while AgentLink is still single-user dogfood. Use when adding a feature flag, experimental setting, new default behavior, settings or storage format change, or when asking whether to ship something off by default.
---

# Dogfood Feature Defaults

AgentLink currently has no public usage: Tristan is the only user, building and testing it daily. Until Tristan explicitly says there is public usage, ship new behavior **on by default** with a way to turn it off, and do not spend effort protecting other users from breaking changes.

This policy is temporary. When Tristan says AgentLink has public users or that breaking changes now need care, stop applying it, tell him which experimental defaults are still on (see the list below), and ask how each should roll out.

## While this policy applies

- Default new behavior **on**. The point is to dogfood it; an opt-in feature mostly goes untested.
- Give every default-on behavior that can misbehave an **off switch**, normally a boolean `agentlink.*` setting. Start its description with `Experimental:` and say what turning it off restores.
- Prefer a design where any doubt falls back to the existing behavior, so turning it off is rarely needed.
- Breaking changes to settings, stored session or telemetry formats, and internal contracts are acceptable. Do not add migrations, compatibility shims, or deprecation periods unless Tristan asks. Still keep reading old local data without crashing when that is cheap, such as tolerating a missing field.
- Do not ask Tristan whether something should be on by default. Default it on, and point out the off switch in the final summary.
- Everything else stays the same: validation gates, docs, CHANGELOG, and the repository's commit and push convention.

## Checklist for a default-on experimental setting

1. `package.json`: add the setting with `"default": true`, the right `scope`, and an `Experimental:` description.
2. Plumb it like `autoCondense`: `AgentConfig` in `src/agent/types.ts`, the `AgentSession` field defaulting to `true`, startup config and the `onDidChangeConfiguration` refresh in `src/extension.ts`, the resource-scoped snapshot in `src/agent/AgentSessionManagerHost.ts`, and `PROJECT_SCOPED_AGENTLINK_SETTINGS` in `src/adapters/vscode/projectSettingsAccessor.ts` for resource-scoped settings. Sessions copy config when they are created, so make the off switch reach open sessions too (see `backgroundCondense` in `AgentSessionManager.updateConfig`).
3. Add telemetry that shows whether it helps, ideally a before/after signal visible in an existing `npm run telemetry:*` report.
4. Document it in the owning guide under `resources/builtin-skills/documentation/references/`, run `npm run docs:generate`, and add a CHANGELOG entry that names the setting for turning it off.
5. Add the setting to the list below.

## Experimental defaults currently on

- `agentlink.backgroundCondense`: prepares the auto-condense summary in the background before the threshold (`src/agent/condensePreparation.ts`). Measure it with `npm run telemetry:context` (Condense timing section).
