---
name: surface-parity
description: Bring proven VS Code agent capabilities to AgentLink's other agent surfaces (CLI, Desktop, Ask Agent in Desktop and the browser gateway, Assistant) and to SDK embedders by porting shared code instead of rebuilding it. Use when adding or changing tools, prompts, skills, instructions, memory, condensing, modes, approvals, or agent behavior in apps/cli, apps/server, apps/desktop, src/browser-gateway/helper, packages/core, packages/node-host, or packages/workspace-host, or when asked about parity, porting, or a second implementation.
---

# Surface Parity

VS Code is AgentLink's reference surface: the most used, most mature agent, and the spec for agent behavior. Work on every other agent surface means bringing over what already works in VS Code, not building a new version of it. Prefer slowing down to reach real parity over rushing to match a headline feature.

## Agent surfaces

| Surface                                 | Where the agent runs                                                                                                             | Own role to keep                                                                                                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VS Code                                 | `src/agent` (`AgentSession`, `toolAdapter.ts`, `systemPrompt.ts`, `condense.ts`)                                                 | Reference. Editor integration (diff review, LSP, terminals, editor state).                                                                                                                                                       |
| CLI                                     | `apps/cli` on `packages/workspace-host` (`createWorkspaceHost`)                                                                  | Terminal-first coding agent: TUI, preview status, owner config under `~/.agentlink`.                                                                                                                                             |
| Assistant                               | `apps/server` (project chats in `assistantService.ts`, task runner in `sessionRunner.ts`) on `workspace-host`                    | Personal assistant: persona, jobs, tasks, repositories, browsing, approval cards and messages instead of `ask_user`, project network policy, task isolation.                                                                     |
| Ask Agent (Desktop and browser gateway) | `src/browser-gateway/helper` (`browserGatewayHelper.ts`, `runAgentToolLoop`), shown in the Desktop app and the browser remote UI | A full agent of its own, with a projectless default and helper-owned tool execution. Restrictions are limited to what the surface cannot safely do (writes, shell, editor, secrets); everything else should behave like VS Code. |
| Desktop remote view                     | Drives real VS Code sessions                                                                                                     | Gets VS Code parity directly.                                                                                                                                                                                                    |
| SDK embedders                           | `packages/core`, `packages/protocol`, `packages/node-host`, `packages/workspace-host`                                            | Anyone building an agent on the SDK. They choose which capabilities to compose.                                                                                                                                                  |

Treat Ask Agent and the SDK as first-class targets, not afterthoughts. A capability that only one standalone surface can use is half done.

## Principles

- **Port, don't rebuild.** Start from the VS Code implementation. Find what stops it running elsewhere and remove that coupling, so VS Code and the other surfaces run the same code.
- **VS Code behavior is the spec.** Keep the same tool names, input schemas, result shapes, limits, and error messages unless a surface genuinely cannot support something. Record each difference as a gap, not as a different contract.
- **Shared capabilities live in the SDK as opt-in pieces.** Put portable logic in the SDK packages behind a small composable option or factory (follow the `workspace-host` pattern: `files`, `commands`, `structuralIndex`, `hostTools`, `languageIntelligence`). Every SDK-based agent, including Ask Agent and third-party embedders, can then adopt it with a few lines and leave it out if it doesn't fit.
- **Inject authority, share logic.** Surfaces supply policy, credentials, network transport, approval UI, filesystem scope, and storage roots. Shared code never imports server policy, keychains, `vscode`, or application modules.
- **No VS Code regressions.** Extraction must leave VS Code behavior and performance unchanged. Prove it with VS Code's existing tests, plus a before/after timing check where performance matters.
- **Gaps before features.** Close parity gaps in tools a surface already advertises before adding new tools to it.
- **Keep each surface's identity.** Parity covers shared agent behavior. It does not erase deliberate differences such as the Assistant's persona and job tools, its no-`ask_user` model, task isolation, Ask Agent's projectless default, or the CLI's terminal UX. Name these differences explicitly when you rely on them.

## Porting checklist

1. **Find the VS Code version.** Locate the tool or behavior in `src/shared/toolRegistry.ts`, `src/shared/toolSchemas.ts`, `src/agent/toolAdapter.ts`, `src/tools/`, or `src/agent/`. Read its schema, result shape, limits, and tests.
2. **Check every agent surface.** For CLI, Assistant (both chat and task runner), Ask Agent, and the SDK, note whether the capability exists, whether it shares VS Code's code or has its own copy, and how its contract differs.
3. **Identify the coupling.** Usual blockers:
   - a `vscode` import (workspace, watchers, editor, `findFiles`)
   - approval UI mixed into the handler (`ApprovalManager`, approval panels)
   - extension-host lifecycle (activation, forked workers, disposables)
   - native packaging (LanceDB, tree-sitter, ripgrep) for the CLI bundle, Desktop, or the Linux runner image
     Many modules are already free of `vscode`; check imports before assuming a rewrite is needed.
4. **Extract a surface-neutral seam.** Move the handler core or logic into the right SDK package, or into a `vscode`-free module that SDK packages can consume. Keep a thin VS Code adapter so the VS Code path stays identical. Add a boundary test where an import could creep back.
5. **Compose it per surface.** Expose it as an opt-in SDK option or factory. Wire it into the CLI, the Assistant, and Ask Agent where it fits their role, and say why where it doesn't. Each surface supplies its own approval, policy, and scope adapters.
6. **Match the contract.** Same name, schema, results, limits, and error codes as VS Code. If a surface cannot support part of it, drop the unsupported fields explicitly and document that as a gap. Don't silently accept a variant.
7. **Test the seams.** Keep VS Code tests passing unchanged. Add a production composition test per wired surface that sends distinctive input through and checks the terminal consumer receives it (see Cross-Layer Callback and Request Plumbing in `CLAUDE.md`).
8. **Document.** Update the owning guide under `resources/builtin-skills/documentation/references/` (`tools.md`, `standalone-cli.md`, and the relevant SDK README) and CHANGELOG, and list remaining gaps.

## When a second implementation is acceptable

Only when sharing is genuinely impractical, for example a native dependency that cannot ship on a surface. Then:

- write down the reason where the code lives,
- label it a fallback and keep it small (don't let it grow features VS Code doesn't have),
- keep VS Code's contract so it can be replaced later,
- record what would let it be deleted.

Example: the CLI's lightweight structural index (`src/indexer/standalone/`) is an interim fallback for `get_repo_map` and `get_module_neighbors` until the VS Code LanceDB indexer can run in standalone hosts.

## Red flags

- A new handler for a tool name VS Code already has.
- A standalone schema that renames fields (`maxResults` vs `max_results`) or narrows options without a recorded gap.
- A capability wired into one standalone surface only, with no SDK option others could use.
- Changing VS Code's behavior to fit a weaker standalone implementation.
- Comments or docs claiming sharing or parity that the code doesn't deliver.
