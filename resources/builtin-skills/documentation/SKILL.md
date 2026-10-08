---
name: documentation
description: Answer questions about AgentLink's VS Code extension and standalone Desktop and CLI previews, including installation, update notifications, onboarding, providers, settings, tools, MCP, approvals, browser remote, indexing, skills, modes, troubleshooting, and contributing. Use when users ask how AgentLink works, what a feature or setting does, how to configure it, or why an AgentLink behavior occurs.
---

# AgentLink Documentation

Use this skill to answer questions about AgentLink from the bundled product documentation in this skill directory.

## Strict source boundary

The files under this skill directory are the complete runtime documentation source:

- `README.md` is the human-facing documentation index.
- `references/*.md` contain the detailed product reference.

Read these bundled documentation files with `read_skill_resource`: pass this skill's `SKILL.md` path (the `skillPath` from activation) as `skill_path` and the path relative to this directory, such as `references/tools.md`, as `resource_path`. Reading a reference does not activate anything. Use `offset` and `next_offset` to page long references. Do not pass reference paths to `load_skill`; it only activates `SKILL.md` files.

When this skill is active, **do not read files outside this directory** to answer AgentLink product questions. In particular, do not inspect the extension installation's root `README.md`, `package.json`, `CHANGELOG.md`, TypeScript/source files, build output, user settings, or other local files to fill a documentation gap. Those reads can look like unexplained access to the user's extension installation.

If the relevant bundled reference does not document a detail, say: **“The bundled AgentLink documentation does not cover that detail.”** Do not guess and do not explore the extension installation for an answer.

## Topic routing

Read the smallest relevant reference page directly with `read_skill_resource`:

| User question                                                                                                                                                     | Read                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Install or use the standalone CLI preview; terminal chat, CLI providers, sessions, storage, limits, commands, or current slice boundaries                         | `references/standalone-cli.md`                                                                                        |
| Embed AgentLink in an app, desktop runtime, CLI, or cloud service; SDK package architecture; host tools, sessions, approvals, or migration from another agent SDK | `references/embedding-agentlink.md`                                                                                   |
| What AgentLink is, modes, chat surfaces, context, memory, editor entry points, or images                                                                          | `references/capabilities.md`, then `references/complete-reference.md` if it needs detailed behavior                   |
| Install or use the standalone Desktop preview; install/update the VS Code extension, first run, sign-in, providers, first task, or setup failure                  | `references/getting-started.md`, then `references/troubleshooting.md` or `references/complete-reference.md` if needed |
| Tool parameters, response shape, write-marker grammar, terminal recovery, or background-tool contracts                                                            | `references/tools.md`, then `references/complete-reference.md` for an exact contract                                  |
| Terminal, indexing, browser remote, MCP, plugin, authentication, or installation failures                                                                         | `references/troubleshooting.md`, then the owning focused guide or `references/complete-reference.md`                  |
| Settings, exact default, scope, allowed values, or setting name                                                                                                   | `references/package-contract.md`, then `references/settings.md` or `references/complete-reference.md` for behavior    |
| MCP setup, precedence, server format, MCP tools/resources/prompts, or Agent Plugin MCP behavior                                                                   | `references/mcp.md`, then `references/complete-reference.md` if needed                                                |
| Instructions, rules, custom modes/commands, skills, Agent Plugin install/scope/declarations/management, or autonomous memory                                      | `references/customization.md`, then `references/complete-reference.md` if needed                                      |
| Exact contributed command, command-palette title, view, package version, engine requirement, or extension metadata                                                | `references/package-contract.md`                                                                                      |
| Release history or upgrade notes                                                                                                                                  | `references/release-notes.md`                                                                                         |

For provider configuration, OpenRouter, local endpoints, or Claude Code authentication through Meridian, read `references/providers.md` first. It owns the setup walkthrough and connection-file examples; `references/settings.md` owns advanced connection behavior.

For update availability, self-update installation, restart/reload prompts, automatic-check opt-out, dismissal, manual checks, and host-specific browser notices, read `references/getting-started.md` first; CLI commands are owned by `references/standalone-cli.md`. Checks retrieve metadata only. Explicit install actions download and verify a release, then install it; restarting or reloading requires separate user consent. Browser remote views have no install or restart action, source builds must be updated from source, and a locally signed Desktop build can switch to the unsigned release after a Keychain warning.

## Answering checklist

1. Use `read_skill_resource` to read the owning bundled reference before answering a detailed question.
2. For exact extension metadata, command, view, setting, default, scope, enum, or pattern, read `references/package-contract.md`. For behavior and workflows, read the owning topic page. Do not infer values from source code.
3. Distinguish the VS Code experience from the browser remote. The browser is read-only for diffs and has no shell or write path.
4. For indexing, distinguish default local lexical/structural retrieval from explicitly enabled OpenAI embeddings, which may send source chunks and queries to OpenAI.
5. If the documentation does not cover the requested detail, state the gap plainly instead of reading outside this skill directory.
