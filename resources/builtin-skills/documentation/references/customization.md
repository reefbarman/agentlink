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

## Lifecycle hooks

AgentLink supports additive `hooks.json` command hooks using a common Codex/Claude-compatible shape. It loads global sources from `~/.agents`, `~/.claude`, `~/.codex`, and `~/.agentlink`, then the same directories in the current project, then enabled Agent Plugin hooks. Hook definitions can use `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, and `Interrupt` events. Matchers, command timeouts, asynchronous handlers, compact JSON stdin, exit-code blocking, and event-specific JSON output follow the compatible conventions. Recognized `mcp_tool`, `prompt`, and `agent` handlers are currently skipped with diagnostics.

Manual command hooks require explicit definition-hash trust before first execution. Changing the event, matcher, or handler invalidates that trust. Plugin commands are disclosed during install/update review and run only from the enabled immutable package generation. Hook commands execute locally outside AgentLink's command sandbox, but hook decisions never grant AgentLink tool authority: rewritten calls still pass normal validation and approvals, and `PermissionRequest` hooks may deny but do not auto-approve AgentLink actions.

Tool matchers accept AgentLink's canonical names plus common command/edit aliases (`Bash`, `Shell`, `shell_command`, `apply_patch`, `Edit`, `Write`). AgentLink runs tool hooks around in-process tools, including nested calls and `todo_write`. External ACP agents execute their own tools, so AgentLink emits subagent lifecycle hooks for them without claiming pre/post interception inside the external process.

## Agent Plugins

On macOS/Linux, `/plugin` and the Agent Plugin manager install and manage canonical Agent Plugins 1.0.0 packages containing Agent Skills, lifecycle hooks, and MCP servers. Running `/plugin` without arguments opens the manager in the Chat Activity Shelf with usage help. Windows loading is disabled. `/plugins` lists the current project's global, project, and declared entries. Packages in another harness's plugin format are not automatically translated into this standard.

Supported sources are Git HTTPS/SSH/SCP remotes, HTTP(S) ZIP/TAR archives, file URLs, local directories, direct `plugin.json` paths, and local ZIP/TAR-family archives. A source may contain one plugin or a collection. Use:

- `/plugin install <source> [--ref <branch-or-tag>]` (alias: `add`)
- `/plugin install-declared <name>` for an entry already present in the current project's declaration file
- `/plugin list`
- `/plugin enable <install-id-or-name>` / `disable`
- `/plugin update <install-id-or-name>` (alias: `reinstall`)
- `/plugin uninstall <install-id-or-name>` (aliases: `remove`, `rm`)
- `/plugin purge` to request safe cleanup after all AgentLink windows close

AgentLink stages and bounds acquisition, validates the canonical schema, and shows source, digest, manifest metadata, skills, lifecycle hook commands, and MCP commands/URLs before installation or update. The explicit choices are **Install and Enable** or **Install Disabled**. Plugin metadata never grants AgentLink approvals, and dependency/setup scripts are never run automatically. Runtime uses immutable managed copies under `~/.agentlink/plugins/packages/`; source/download bytes are not executed in place. Local absolute source paths are not persisted, so replace a local-directory/archive install by running `install` again.

An install can be global or project-scoped. In the owning project, an enabled project install shadows an enabled global install with the same manifest name. Shareable project sources are written to `<workspace>/.agentlink/plugins.json` as a workspace-relative directory or pinned Git commit. This committed declaration has zero activation authority: it contains no enablement, trust, policy, credentials, absolute local path, data, or package bytes, and `install-declared` still runs the normal acquisition and review flow. Archive and outside-workspace sources stay machine-local. Projectless sessions load no plugin components.

The VS Code manager supports install, diagnostics, enable/disable, update, rollback to the validated previous generation, uninstall, data deletion, and editable MCP policy. The browser remote shows a bounded read-only inventory and directs all mutations to VS Code. Plugin data is stored separately under `~/.agentlink/plugin-data/` and survives updates and ordinary uninstall/reinstall unless explicitly deleted.

## Autonomous memory, /memory, and /remember

`agentlink.memory.mode = autonomous` enables typed low-authority memory. `/memory` opens a local manager without a model request: inspect/filter records and provenance, revisions, and audit history; forget/restore, undo, clear a confirmed scope, or import/export versioned archives. VS Code supports global and current-project scopes; projectless Browser Ask Agent supports global scope only. `/remember` is the model-assisted workflow for identifying durable candidates.

Autonomous memory remains evidence only and uses `manage_memory` / `recall_memory`; it cannot authorize tools or override current user, repository, instruction, skill, or command evidence. Legacy global/project `.agentlink/memory.md` files are imported idempotently and left byte-identical for rollback rather than injected directly into the prompt.

`propose_memory` is the reviewed approval flow for authoritative instructions, reusable skills, and slash commands. The bundled `cross-session-memory` skill explains when to use autonomous memory versus a reviewed configuration proposal.
