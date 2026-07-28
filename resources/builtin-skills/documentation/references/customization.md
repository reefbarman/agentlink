# Customizing AgentLink

AgentLink layers configuration from three directory conventions — `.agents` (cross-agent standard), `.claude` (Claude Code compatibility), and `.agentlink` (AgentLink-specific) — at global (`~/`) and project scope. Later sources take precedence; `.agentlink` is highest within a scope, and project scope beats global.

## Instruction files (AGENTS.md / CLAUDE.md)

Loaded in priority order (later overrides earlier):

1. Global: `~/.agents/AGENTS.md` + `~/.agents/rules/*.md`, then `~/.claude/CLAUDE.md` + rules, then `~/.agentlink/CLAUDE.md` + rules
2. Workspace root: first found of `AGENTS.md` / `AGENT.md` / `CLAUDE.md`
3. Project dirs: `.agents/AGENTS.md`, `.claude/CLAUDE.md`, then `.agentlink/AGENTS.md` (falling back to `.agentlink/CLAUDE.md`), each with `rules/*.md`
4. Subfolder instructions: the first non-empty `AGENTS.md` / `AGENT.md` / `CLAUDE.md` in each directory from the root down to the active file's directory, plus `AGENTS.local.md`
5. `AGENTS.local.md` in workspace root — personal overrides, gitignored by convention

Use project `.agentlink/AGENTS.md` for AgentLink-specific shared instructions. AgentLink loads the first non-empty file between `.agentlink/AGENTS.md` and `.agentlink/CLAUDE.md`.

For personal additions to committed root instructions, create a workspace-root `AGENTS.local.md` and keep it uncommitted. Prefer adding `/AGENTS.local.md` to `.git/info/exclude` when the exclusion should remain local rather than changing the project's shared `.gitignore`. Subfolder `AGENTS.local.md` files provide personal instructions scoped to files below those directories. Changes to workspace-root and project `.agentlink` instruction files are picked up automatically for subsequent agent requests; start a new session after changing global instructions or other sources that are not watched.

Rules can also be advertised and loaded on demand via the `load_rule` tool.

## Custom modes

Project-level only, from `modes.json` in `.agents` / `.claude` / `.agentlink` (ascending priority). Custom modes can override built-in modes (`code`, `review`, ...). A mode defines a slug, name, and `toolGroups`. Note: `get_completions`, `get_inlay_hints`, `get_code_actions`, and `apply_code_action` are hidden from ordinary modes; expose them only via an explicit mode with the `language-benchmark` tool group.

## Custom slash commands

Markdown prompt files in `commands/` directories, later sources winning:

`~/.agents/commands/`, `~/.claude/commands/`, `~/.agentlink/commands/`, then project `.agents/commands/`, `.claude/commands/`, `.agentlink/commands/`.

Each file becomes a `/<name>` command that injects its body as a prompt.

## Skills

Directories containing a `SKILL.md` with single-line YAML frontmatter (`name`, `description`, optional `modeSlugs`, `allowed-tools`, `invocation`). Discovery walks the workspace ancestor chain and reads `skills/` plus mode-specific `skills-<mode>/` directories under the global/project `.agents`, `.claude`, and `.agentlink` conventions; AgentLink's bundled skills have the lowest priority. The canonical catalog validates identity and frontmatter, resolves collisions deterministically with provenance diagnostics, applies per-skill enablement and mode/dependency policy, and preserves each skill's tool restrictions through activation and restored/background sessions. Detected skills:

- appear in the bounded system-prompt Skills catalog and load on demand via `load_skill`
- appear in the slash-command picker as `/skill:<name>`
- can be listed with `/skills` (shows resolved `SKILL.md` paths for the current mode)

The bundled `skill-writing` skill documents the authoring spec and AgentLink's frontmatter parser constraints.

## Autonomous memory, /memory, and /remember

`agentlink.memory.mode = autonomous` enables typed low-authority memory. `/memory` opens a local manager without a model request: inspect/filter records and provenance, revisions, and audit history; forget/restore, undo, clear a confirmed scope, or import/export versioned archives. VS Code supports global and current-project scopes; projectless Browser Ask Agent supports global scope only. `/remember` is the model-assisted workflow for identifying durable candidates.

Autonomous memory remains evidence only and uses `manage_memory` / `recall_memory`; it cannot authorize tools or override current user, repository, instruction, skill, or command evidence. Legacy global/project `.agentlink/memory.md` files are imported idempotently and left byte-identical for rollback rather than injected directly into the prompt.

`propose_memory` is the reviewed approval flow for authoritative instructions, reusable skills, and slash commands. The bundled `cross-session-memory` skill explains when to use autonomous memory versus a reviewed configuration proposal.
