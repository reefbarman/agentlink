---
name: documentation
description: Answer questions about AgentLink itself — what it can do, its tools, modes, models, settings, MCP server setup, slash commands, skills, approvals, browser remote access, and troubleshooting. Use whenever the user asks how AgentLink works, what a feature or setting does, how to configure or connect something (MCP, models, semantic search, web access), or why an AgentLink behavior is happening.
---

# AgentLink Documentation

Use this skill to answer questions about AgentLink — the extension you are running inside — and to help the user configure it.

## Authoritative sources

This SKILL.md lives at `<extension-root>/resources/builtin-skills/documentation/SKILL.md`. Derive `<extension-root>` from this file's own path (three directories up) and read these shipped files with `read_file` when you need detail beyond this skill:

| File                            | Authoritative for                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<extension-root>/README.md`    | Full user documentation: features, installation, per-tool reference, MCP, web access, semantic search, approvals, browser remote, troubleshooting             |
| `<extension-root>/package.json` | The exact list of settings (`contributes.configuration`), commands, and views. Always verify setting names, defaults, and enum values here — never guess them |
| `<extension-root>/CHANGELOG.md` | What changed in which release                                                                                                                                 |

The README is large. Do not read it whole — jump to the relevant section with `search_files` on the extension root or a targeted `read_file` range.

## Topic routing

Start with the matching reference file in this skill's `references/` directory, then drill into the README/package.json for specifics:

- **"What can AgentLink do?" / modes / models / slash commands / background agents / checkpoints / browser remote / terminal / autonomous memory / context management / semantic retrieval** → `references/capabilities.md`
- **Settings ("how do I change/enable X?")** → `references/settings.md`, then confirm the setting in `package.json`
- **MCP servers (connect, configure, debug)** → `references/mcp.md`
- **Custom modes, custom slash commands, skills, rules, AGENTS.md/CLAUDE.md instruction files, `/memory`, `/remember`, and reviewed durable configuration** → `references/customization.md`
- **A specific built-in tool's parameters or behavior, or diagnosing why an operation happened** → README `## Tools` section (`diagnose_activity` for structured current-session evidence)
- **Installation / upgrading / platform issues / troubleshooting** → README sections of the same name

## Answering checklist

1. Prefer the shipped files above over recall. Setting names, defaults, and command lists must come from `package.json` or the README, not memory.
2. When telling the user to change a setting, give the exact `agentlink.*` key and where to set it (VS Code Settings UI or `settings.json`).
3. Distinguish surfaces: the VS Code chat is the full experience; the browser remote is intentionally read-only for diffs and has no shell/write paths. `/btw` and `/worktree` are VS Code-only.
4. If a question is about behavior you can demonstrate (e.g. "what does /skills show?"), it is fine to just do it.
5. If the docs genuinely do not cover something, say so rather than inventing behavior.
