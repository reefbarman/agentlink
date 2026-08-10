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
| **Background agents** | Parallel research and review with visible Fleet status, budgets, and results.                      |
| **Browser remote**    | Check on sessions, answer questions, review diffs, and supervise work from a paired browser.       |
| **MCP**               | Layered user/project MCP configuration and progressively disclosed tools, resources, and prompts.  |
| **Customization**     | `AGENTS.md`/`CLAUDE.md`, rules, skills, custom modes, custom slash commands, and auditable memory. |

## Documentation

Detailed product documentation ships with the extension and is also what the built-in documentation skill uses.

- [Documentation index](resources/builtin-skills/documentation/README.md)
- [Complete product reference](resources/builtin-skills/documentation/references/complete-reference.md)
- [Generated package contract](resources/builtin-skills/documentation/references/package-contract.md) — exact commands, views, settings, defaults, scopes, and allowed values
- [Release notes](resources/builtin-skills/documentation/references/release-notes.md)

The bundled documentation skill is self-contained: it uses these shipped references instead of reading extension source files or local settings to answer product questions.

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
