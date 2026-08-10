# AgentLink Documentation

These are the shipped product docs for AgentLink. They are written for people using the VS Code extension and are also the complete reference material used by AgentLink's built-in documentation skill.

## Start here

- [Project overview](../../../README.md) — what AgentLink is, why it exists, installation, and first-run path.
- [Complete product reference](references/complete-reference.md) — installation, providers, codebase indexing, approvals, browser remote, tools, MCP, settings, troubleshooting, and development details.
- [Capabilities overview](references/capabilities.md) — modes, chat surfaces, context, memory, editor integrations, and major workflows.

## Focused guides

- [Settings](references/settings.md) — grouped `agentlink.*` settings and their purpose.
- [MCP](references/mcp.md) — configure and use Model Context Protocol servers.
- [Customization](references/customization.md) — instructions, rules, modes, slash commands, skills, and memory.
- [Package contract](references/package-contract.md) — generated exact commands, views, settings, defaults, scopes, and allowed values.
- [Release notes](references/release-notes.md) — generated copy of the current release history.

## Documentation behavior

Each topic page includes the commands, settings, defaults, and limits needed for that subject. The built-in documentation skill answers only from this bundled directory; it does not inspect the installed extension, source code, package metadata, or local settings to fill a documentation gap.
