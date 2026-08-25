# AgentLink

**AgentLink is an AI coding-agent harness built into VS Code.** It gives an agent the editor's language intelligence, visible integrated-terminal execution, reviewable diffs, granular approvals, background reviewers, MCP integrations, and browser-based remote supervision.

It is for people who want capable coding agents without giving up the ability to steer, inspect, approve, and undo their work.

## Why AgentLink

Most coding agents work at the filesystem boundary. AgentLink works through VS Code instead:

- **Editor-native context** — language-server navigation, diagnostics, symbols, references, code actions, and renames give the agent the same code understanding available in your editor.
- **Reviewable changes** — file edits open in VS Code diff views. Accept, reject, or adjust the change yourself; your edits become feedback for the agent.
- **Visible execution** — commands run in VS Code's integrated terminal, not an unseen subprocess.
- **Control at every level** — use granular approval rules, checkpoints, activity visibility, background-agent coordination, and the browser remote to supervise work without losing momentum.
- **Useful context without a cloud index** — AgentLink builds a local codebase index for lexical and structural retrieval; optional embeddings require explicit consent before they add vector and hybrid ranking.
- **An open integration boundary** — connect MCP servers for the capabilities your workflow already uses.

Read [why AgentLink](why-agentlink.md) for the longer product perspective.

## Install

### Install the latest release

The install script selects the target for the VS Code extension host on this machine:

```sh
curl -sL https://raw.githubusercontent.com/reefbarman/agentlink/main/scripts/install.sh | bash
```

For a remote or emulated extension host, specify its target explicitly:

```sh
curl -sL https://raw.githubusercontent.com/reefbarman/agentlink/main/scripts/install.sh \
  | AGENTLINK_VSCE_TARGET=linux-x64 bash
```

You can also download a target-specific `.vsix` from the [latest release](https://github.com/reefbarman/agentlink/releases/latest) and install it with:

```sh
code --install-extension agentlink-*.vsix --force
```

See the [getting started guide](resources/builtin-skills/documentation/references/complete-reference.md#installation) for source builds, platform details, and AgentLink Terminal requirements.

## First run

1. **Reload VS Code**, then open the folder you want to work in. Without a folder, AgentLink remains available as a deliberately limited Ask-only chat with no workspace, terminal, MCP, or approval tools.
2. Open the **AgentLink** activity-bar icon and choose the **Agent** view.
3. The empty chat explains whether the selected model is ready. On a fresh install, click **Continue with ChatGPT/Codex** to start the recommended sign-in path directly. You can instead choose an OpenAI or Anthropic API key, or configure an OpenAI-compatible provider.
4. AgentLink keeps any draft you type while setup is incomplete and enables sending as soon as credentials are configured. It does not verify provider connectivity until the first request, so normal provider errors such as quota or revoked credentials still appear if applicable.
5. Let AgentLink build or refresh your local codebase index. Local lexical retrieval works without credentials; vector/hybrid ranking requires an explicit embedding-consent setting, even if credentials already exist. See [codebase indexing](resources/builtin-skills/documentation/references/complete-reference.md#semantic-codebase-search-setup) for controls.
6. Give the agent a bounded first task, such as:

   > Read this project, explain the main module boundaries, and identify the safest place to add a new `<feature>`.

7. Review proposed edits in the diff view and approve commands or other boundaries when AgentLink asks. Use `/checkpoint` before risky work and `/revert` if you need to undo it.

## Highlights

| Area                  | What it gives you                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| **Modes**             | Focused code, planning, debug, review, and Ask workflows without losing the session.               |
| **Approvals**         | Inline review for edits, commands, renames, MCP, paths, and high-risk boundaries.                  |
| **Background agents** | Parallel research and review with visible Fleet status, work-unit budgets, and results.            |
| **Browser remote**    | Check on sessions, answer questions, review diffs, and supervise work from a paired browser.       |
| **MCP**               | Layered user/project MCP configuration and progressively disclosed tools, resources, and prompts.  |
| **Customization**     | `AGENTS.md`/`CLAUDE.md`, rules, skills, custom modes, custom slash commands, and auditable memory. |
| **Agent Plugins**     | Review-gated managed imports from Git, URLs, directories, manifests, ZIPs, and TAR archives.       |

## Agent Plugins

AgentLink supports standards-compliant Agent Plugins 1.0.0 on macOS and Linux. A plugin can contribute Agent Skills and MCP servers using `stdio`, Streamable HTTP, or legacy SSE. Windows plugin loading is currently disabled. Packages that use another harness's plugin format without the canonical Agent Plugins 1.0.0 schema are not treated as Agent Plugins; their individual skills may still be discovered through AgentLink's normal skill directories.

Install from the **AgentLink: Manage Agent Plugins** panel, **AgentLink: Install Agent Plugin From Source**, or `/plugin`. Running `/plugin` without arguments opens the manager in the Chat Activity Shelf with usage help. Accepted sources include Git HTTPS/SSH/SCP remotes, HTTP(S) ZIP/TAR archives, file URLs, local directories, direct `plugin.json` paths, and local ZIP/TAR-family archives. Repositories and archives may contain one plugin or a collection; AgentLink validates the candidates and asks which one to install.

```text
/plugin install <source> [--ref <branch-or-tag>]
/plugin install-declared <name>
/plugin list
/plugin enable <install-id-or-name>
/plugin disable <install-id-or-name>
/plugin update <install-id-or-name>
/plugin uninstall <install-id-or-name>
/plugin purge
```

Acquisition is staged and bounded. Archives reject traversal, absolute or case-colliding paths, symlinks, special files, excessive counts/sizes, and unsafe compression ratios. Git acquisition restricts protocols and arguments, does not initialize submodules or run dependency/setup hooks, and materializes only the selected commit. Before installation or update, a modal review shows source, digest, manifest metadata, skills, and every MCP command or remote URL. Choose **Install and Enable** or **Install Disabled**. Plugin metadata and project declarations never grant command, write, network, native-tool, or MCP-tool approval.

Enabled plugin skills join the current project's skill and slash-command catalog. Plugin MCP servers join the same discovery, connection, policy, and tool-approval flows as native MCP configuration, but keep plugin provenance and independent failure isolation. **A plugin `stdio` server executes a local process outside AgentLink's command sandbox.** Review its command, arguments, working directory, and environment before enabling it; ordinary MCP tool approvals still apply after connection. Configured HTTP headers are restricted to the reviewed MCP origin and are not forwarded into OAuth or cross-origin redirect traffic.

Installed packages are immutable managed copies under `~/.agentlink/plugins/packages/`; source directories and downloads are never executed in place. The coordinated registry is `~/.agentlink/plugins/registry.json`, while persistent component data lives separately under `~/.agentlink/plugin-data/`. Updates atomically select a new verified generation, retain the previous generation for rollback, preserve plugin data, and refresh affected skills and MCP connections across open windows. Local absolute source paths are deliberately not persisted, so replacing a local-directory/archive install requires `/plugin install <source>` again. Uninstall leaves immutable bytes until `/plugin purge` can remove unreferenced generations on a later safe startup after all AgentLink windows close; data removal is a separate explicit action.

Installs can be global or project-scoped. In a project, an enabled project plugin shadows an enabled global plugin with the same manifest name. Shareable project sources are recorded in `<workspace>/.agentlink/plugins.json` as either a workspace-relative directory or a pinned Git commit. This declaration contains no trust, enablement, policy, credentials, absolute local path, or package bytes; a fresh clone shows it as declared but still requires local acquisition and the full review flow. Sources outside the workspace and archives remain machine-local rather than being written into the declaration.

The VS Code manager can install, inspect diagnostics, enable/disable, update, select the previous rollback generation, uninstall, and edit plugin MCP policy. The browser remote can inspect the same bounded manager state for a project, but all plugin mutation remains explicitly VS Code-only. Projectless sessions load no plugin components.

## Background review budgets

Review agents are bounded by useful work rather than input size. Automatic tiered budgets count committed tool calls, successful model API turns, and elapsed time; token and estimated-cost caps are ignored for review task classes so a large captured diff cannot exhaust the budget before the reviewer explores surrounding code. Non-review background tasks remain uncapped by default and can still use explicit token, cost, tool-call, turn, or elapsed-time limits. Soft limits request wrap-up, with a 3× hard safety backstop for runs that do not finish.

## Write tools

AgentLink's single-file write tools use the same reviewed save boundary. After an approved edit is saved, AgentLink reads the file from disk and compares it with the approved editor content. A successful result includes `durability.status: "durable"`, an `exact` or `transformed` outcome, and `post_edit_content_hash` (SHA-256 of the final disk content). Reverted edits, editor/disk divergence, unreadable or missing files, and transformations of exact-preservation formats return canonical errors; AgentLink reports the observed state rather than overwriting it automatically.

With **Approve for Me** active, `write_file` and `apply_diff` may write directly under the operating system's canonical temporary roots (including the per-user temp root and `/tmp` aliases on macOS) without a separate outside-workspace approval. This narrow exception does not apply in manual approval modes or to protected instruction/memory files, `.env*` files, credential stores, authenticated CLI configuration, unresolved paths, or symlink escapes.

### `write_file`

Create a file or replace its complete content.

| Parameter | Type   | Description                          |
| --------- | ------ | ------------------------------------ |
| `path`    | string | Workspace-relative or absolute path. |
| `content` | string | Complete proposed file content.      |

### `apply_diff`

Apply one or more reviewed SEARCH/REPLACE blocks to an existing file.

| Parameter       | Type      | Description                                                                                                          |
| --------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| `path`          | string    | Existing file path.                                                                                                  |
| `diff`          | string    | SEARCH/REPLACE blocks.                                                                                               |
| `block_options` | object[]? | Select a 1-based occurrence or intentionally replace every exact occurrence for a block.                             |
| `atomic`        | boolean?  | Require every block to validate before review/write. This validates the proposal; it does not bypass format-on-save. |

If an ordinary save participant transforms the approved content, the write remains accepted with `durability.outcome: "transformed"`. For `apply_diff`, proposal-level successful blocks become `unverified_after_transform` and omit positional ranges because those ranges no longer describe final disk content. Re-read the file whenever `durability.requires_reread` is true. Known Unity serialization files (`.meta`, `.asset`, `.unity`, `.mat`, `.prefab`, `.anim`, `.controller`, and `.physicMaterial`) use VS Code's Save without Formatting path and fail closed instead of falling back to normal save participants.

## Documentation

Detailed product documentation ships with the extension and is also what the built-in documentation skill uses.

- [Documentation index](resources/builtin-skills/documentation/README.md)
- [Complete product reference](resources/builtin-skills/documentation/references/complete-reference.md)
- [Generated package contract](resources/builtin-skills/documentation/references/package-contract.md) — exact commands, views, settings, defaults, scopes, and allowed values
- [Release notes](resources/builtin-skills/documentation/references/release-notes.md)

The bundled documentation skill is self-contained: it uses these shipped references instead of reading extension source files or local settings to answer product questions.

MCP OAuth browser flows are coordinated across project hubs and open VS Code windows to prevent repeated login-tab bursts. Existing servers stay non-interactive across config reloads, explicit Reauthenticate remains available after an active flow finishes, and maintainers can inspect bounded local diagnostics with `npm run telemetry:mcp-auth` (no tokens, headers, authorization URLs, callback parameters, or raw SDK errors are recorded).

## Contributing

AgentLink development requires Node.js 22.19 or newer and VS Code 1.109 or newer.

```sh
git clone https://github.com/reefbarman/agentlink.git
cd agentlink
npm install
npm run build
```

Press **F5** in VS Code to launch an Extension Development Host. Before submitting a production change, run:

```sh
npm run fmt
npm run lint
npm test
```

The [development reference](resources/builtin-skills/documentation/references/complete-reference.md#development) covers packaging, releases, telemetry, feedback tools, architecture boundaries, and the VSIX allowlist.

## Project links

- [Releases](https://github.com/reefbarman/agentlink/releases)
- [Issues](https://github.com/reefbarman/agentlink/issues)
- [Changelog](CHANGELOG.md)
- [License](LICENSE)
