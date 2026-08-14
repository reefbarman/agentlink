---
name: documentation
description: Answer questions about AgentLink's VS Code extension, including installation, onboarding, Codex/OpenAI/Anthropic setup, settings, tools, MCP, approvals, browser remote, codebase indexing, skills, modes, troubleshooting, and contributing. Use when users ask how AgentLink works, what a feature or setting does, how to configure it, or why an AgentLink behavior occurs.
---

# AgentLink Documentation

Use this skill to answer questions about AgentLink from the bundled product documentation in this skill directory.

## Strict source boundary

The files under this skill directory are the complete runtime documentation source:

- `README.md` is the human-facing documentation index.
- `references/*.md` contain the detailed product reference.

Use `load_skill` to load either of these bundled documentation files. When its target is inside an advertised built-in skill directory, `load_skill` resolves the resource and keeps this `SKILL.md` as the owning skill for activation. Use the absolute reference path beneath the advertised skill path; relative tool paths resolve against the workspace, not this skill directory.

When this skill is active, **do not read files outside this directory** to answer AgentLink product questions. In particular, do not inspect the extension installation's root `README.md`, `package.json`, `CHANGELOG.md`, TypeScript/source files, build output, user settings, or other local files to fill a documentation gap. Those reads can look like unexplained access to the user's extension installation.

If the relevant bundled reference does not document a detail, say: **“The bundled AgentLink documentation does not cover that detail.”** Do not guess and do not explore the extension installation for an answer.

## Topic routing

Load the smallest relevant reference page directly with `load_skill`:

| User question                                                                                                                                                                                                       | Load                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| What AgentLink is, modes, chat surfaces, context, memory, editor entry points, or images                                                                                                                            | `references/capabilities.md`, then `references/complete-reference.md` if it needs detailed behavior |
| Install, update, first run, Codex sign-in, providers, models, codebase indexing, approvals, browser remote, web access, tools, terminals, background agents, ACP, worktrees, fleet, troubleshooting, or development | `references/complete-reference.md`                                                                  |
| Settings, exact default, scope, allowed values, or setting name                                                                                                                                                     | `references/package-contract.md`, then `references/complete-reference.md` for behavior              |
| MCP setup, precedence, server format, MCP tools/resources/prompts                                                                                                                                                   | `references/mcp.md`, then `references/complete-reference.md` if needed                              |
| Instructions, rules, custom modes/commands, skills, autonomous memory                                                                                                                                               | `references/customization.md`, then `references/complete-reference.md` if needed                    |
| Exact contributed command, command-palette title, view, package version, engine requirement, or extension metadata                                                                                                  | `references/package-contract.md`                                                                    |
| Release history or upgrade notes                                                                                                                                                                                    | `references/release-notes.md`                                                                       |

## Answering checklist

1. Use `load_skill` to load the owning bundled reference before answering a detailed question.
2. For exact extension metadata, command, view, setting, default, scope, enum, or pattern, use `load_skill` for `references/package-contract.md`. For behavior and workflows, load the owning topic page. Do not infer values from source code.
3. Distinguish the VS Code experience from the browser remote. The browser is read-only for diffs and has no shell or write path.
4. For indexing, distinguish default local lexical/structural retrieval from explicitly enabled OpenAI embeddings, which may send source chunks and queries to OpenAI.
5. If the documentation does not cover the requested detail, state the gap plainly instead of reading outside this skill directory.
