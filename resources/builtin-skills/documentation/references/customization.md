# Customizing AgentLink

AgentLink layers configuration from three directory conventions — `.agents` (cross-agent standard), `.claude` (Claude Code compatibility), and `.agentlink` (AgentLink-specific) — at global (`~/`) and project scope. Later sources take precedence; `.agentlink` is highest within a scope, and project scope beats global.

## Instruction files (AGENTS.md / CLAUDE.md)

Loaded in priority order (later overrides earlier):

1. Global: `~/.agents/AGENTS.md` + `~/.agents/rules/*.md`, then `~/.claude/CLAUDE.md` + rules, then `~/.agentlink/CLAUDE.md` + rules
2. Workspace root: first found of `AGENTS.md` / `AGENT.md` / `CLAUDE.md`
3. Project dirs: `.agents/AGENTS.md`, `.claude/CLAUDE.md`, `.agentlink/CLAUDE.md`, each with `rules/*.md`
4. Subfolder `AGENTS.md` / `AGENTS.local.md` files (apply from root down to the active file's directory)
5. `AGENTS.local.md` in workspace root — personal overrides, gitignored by convention

Rules can also be advertised and loaded on demand via the `load_rule` tool.

## Custom modes

Project-level only, from `modes.json` in `.agents` / `.claude` / `.agentlink` (ascending priority). Custom modes can override built-in modes (`code`, `review`, ...). A mode defines a slug, name, and `toolGroups`. Note: `get_completions`, `get_inlay_hints`, `get_code_actions`, and `apply_code_action` are hidden from ordinary modes; expose them only via an explicit mode with the `language-benchmark` tool group.

## Custom slash commands

Markdown prompt files in `commands/` directories, later sources winning:

`~/.agents/commands/`, `~/.claude/commands/`, `~/.agentlink/commands/`, then project `.agents/commands/`, `.claude/commands/`, `.agentlink/commands/`.

Each file becomes a `/<name>` command that injects its body as a prompt.

## Skills

Directories containing a `SKILL.md` with single-line YAML frontmatter (`name`, `description`, optional `modeSlugs`, `allowed-tools`, `invocation`). Discovered from `skills/` (and mode-specific `skills-<mode>/`) under the same six global/project directories, plus AgentLink's bundled built-in skills (lowest priority). Detected skills:

- appear in the system prompt's Skills section and load on demand via `load_skill`
- appear in the slash-command picker as `/skill:<name>`
- can be listed with `/skills` (shows resolved `SKILL.md` paths for the current mode)

The bundled `skill-writing` skill documents the authoring spec and AgentLink's frontmatter parser constraints.

## Memory and /remember

The agent can persist durable learnings with the `propose_memory` tool (tiers: instructions, skill, command, memory) — always via an approval flow. `/remember` reviews the current session for durable learnings and proposes updates. The bundled `cross-session-memory` skill covers the conventions.
