---
name: add-codex-model
description: Checklist for adding, replacing, or retiring a Codex/OpenAI (GPT) model in AgentLink's picker, routing, prompt profiles, condense thresholds, docs, and tests. Use when a new GPT model ships.
---

# Add a Codex/OpenAI model

Each model's facts and policy live on its `CODEX_MODELS` entry in `packages/core/src/codex/models.ts`. Background routing tiers, review preferences, prompt profiles, and the Codex-aligned condense default are all derived from it. Docs and pinned tests stay manual.

## 1. Get the facts first

- Read the official model page (`developers.openai.com/api/docs/models/<id>`) and the "Using GPT-N" guide: context window, max output, input cap, reasoning efforts and default, Fast/Ultrafast support.
- Check whether it's on ChatGPT/Codex sign-in or API key only, and whether Codex's catalog marks it `use_responses_lite` or gives it different sign-in limits.
- Don't guess. If something isn't published, say so in the final summary.

## 2. `packages/core/src/codex/models.ts`

- `CODEX_MODELS`: add the entry. Required: `routingTier` (`cheap` Luna-class, `balanced` Sol/Terra-class, `deep_reasoning` Astra-class) and `promptProfile` (`reasoning` for Sol/Terra/Astra-class, `compatibility` for Luna/Spark-class). Set `codexAlignedCondense: true` if API prompts above 272K cost more. Then limits, efforts, `defaultTextVerbosity`, `serviceTiers`, and `apiAvailable: false` if sign-in only.
- Array position matters: within a tier, earlier entries win for background routing and reviews. Keep stronger models first (Sols before Terras).
- `CODEX_PICKER_MODEL_IDS`: picker position. Update the "last verified" comment on `CODEX_CHATGPT_BACKEND_MODEL_IDS`.
- Only if needed: `CODEX_OAUTH_MODEL_OVERRIDES` (different sign-in limits or a larger `condenseTargetInputTokens`), `CODEX_OAUTH_RESPONSES_LITE_MODELS`, and for replacements `SUPERSEDED_MODEL_MIGRATIONS` and `getCodexUnavailableModelFallback`.

## 3. Tests

- The "official N models" picker lists in `packages/core/src/codex/models.test.ts`, `src/agent/providers/codex/CodexProvider.test.ts`, and the count in `apps/cli/src/config.test.ts`. Add a capability test for the new model.
- `packages/core/src/codex/models.test.ts` "Codex routing tiers" if the strongest model in a tier changes.

## 4. Docs

- `resources/builtin-skills/documentation/references/`: `capabilities.md` (picker list, availability, Speed tiers), `settings.md` (limits, condense defaults, text verbosity), `providers.md` (prompt profiles), `troubleshooting.md` (rollout and Speed lists).
- `CHANGELOG.md` under `## Unreleased`, then `npm run docs:generate`.

## 5. Validate

- `npx oxfmt <touched files>`, then `npm run lint`.
- Focused tests: `npx vitest run packages/core/src/codex packages/core/src/promptProfilePolicy.test.ts src/agent/providers/codex src/agent/backgroundModelRouter.test.ts src/agent/modelCondenseThresholds.test.ts apps/desktop/src/desktopModelCatalog.test.ts apps/cli/src/config.test.ts`.
