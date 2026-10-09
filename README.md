<p align="center">
  <img src="media/icon.png" alt="AgentLink" width="128">
</p>

# AgentLink

> **A coding-agent harness built into VS Code, with standalone Desktop and CLI previews.**

Run frontier coding agents with the editor's intelligence, visible execution, reviewable changes, and as much, or as little, supervision as the task needs. Use the macOS Desktop app for standalone Ask Agent chat or the Apple Silicon CLI for terminal coding when you do not need an editor.

[Get started](#get-started) · [Documentation](resources/builtin-skills/documentation/README.md) · [Why AgentLink](why-agentlink.md) · [Releases](https://github.com/reefbarman/agentlink/releases)

![AgentLink in VS Code: the agent proposes an Overdue invoice badge in a Next.js app, shown in a native side-by-side diff with an Accept/Reject card in the chat panel](docs/assets/screenshots/vscode-diff-review.png)

## Why AgentLink

A capable model is only part of a capable coding agent. It also needs a good working environment: editor intelligence instead of text guesses, fast feedback instead of a surprise broken build, and a way for you to supervise or redirect work without taking the controls away.

AgentLink works _through_ VS Code. It gives an agent language-server navigation and diagnostics, opens edits in native diff views, runs commands in the terminal you can see, and keeps activity, decisions, and recovery close to the work.

That is the product bet: better context, better feedback, and better control make agents more useful on real codebases—not just more autonomous in a demo. Read the concise [case for AgentLink](why-agentlink.md).

## What makes it different

### The editor is the runtime

Give the agent the same semantic understanding you use: definitions, references, symbols, type information, code actions, diagnostics, and workspace-aware rename. Proposed edits arrive as diffs you can accept, reject, or adjust yourself.

### Autonomy is a dial, not a switch

Review every action when the task is risky, or let familiar work move faster with focused rules and **Approve for Me**. Commands remain visible, approvals carry your feedback back to the agent, and checkpoints make experimentation reversible.

![An AgentLink approval card asking to run a terminal command, with the command, its working directory, the agent's reason, auto-approval rules, and Run/Reject buttons beside the task list](docs/assets/screenshots/vscode-command-approval.png)

### Nothing happens in the dark

Tool calls, progress, questions, approvals, queued work, and background agents stay visible in the chat and Activity Shelf. Use the browser remote to check a session, answer a question, or inspect a read-only diff without taking over the editor.

### A second opinion from another model provider

Use OpenAI/Codex alongside models from configured OpenAI-compatible providers or external ACP agents. AgentLink can route review to another provider, giving important work an independent set of model blind spots.

### Context for the code, not the harness

AgentLink keeps local lexical and structural codebase retrieval on your machine, progressively discloses tools, bounds noisy terminal output, and condenses long sessions without losing the active task.

## What you can do

| Work                      | AgentLink gives you                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Build in the editor**   | VS Code chat, language intelligence, diagnostics, diff review, integrated terminals, and modes for coding, planning, debugging, review, and questions. |
| **Stay in control**       | Inline approvals, editable command requests, audit context, checkpoints/revert, structured questions, and visible task status.                         |
| **Work in parallel**      | Background research and review, cross-provider review, Fleet progress, steering, and bounded results.                                                  |
| **Connect your workflow** | MCP tools, resources, and prompts; `AGENTS.md`/`CLAUDE.md`; skills, custom modes, slash commands, hooks, and Agent Plugins.                            |
| **Use your accounts**     | ChatGPT/Codex, OpenAI, and compatible providers on your own accounts. Local retrieval and telemetry stay local by default.                             |

## Get started

Choose the surface that fits your work: the **VS Code extension** has the fullest editor and review integration; **Desktop** offers Ask Agent chat and a view into running VS Code sessions; the **CLI** runs a local coding session in your terminal. Desktop and CLI are separate, narrower macOS previews.

### Install the VS Code extension

The installer selects the target for the VS Code extension host on this machine:

```sh
curl -fsSL https://raw.githubusercontent.com/reefbarman/agentlink/main/scripts/install.sh | bash
```

For a remote or emulated extension host, set its target explicitly:

```sh
curl -fsSL https://raw.githubusercontent.com/reefbarman/agentlink/main/scripts/install.sh \
  | AGENTLINK_VSCE_TARGET=linux-x64 bash
```

The installer verifies the release checksum when one is published. Add `--version X.Y.Z` to pin a release or `--dry-run` to preview what it would install. You can also download a matching `.vsix` from the [latest release](https://github.com/reefbarman/agentlink/releases/latest):

```sh
code --install-extension agentlink-*.vsix --force
```

### Try the standalone Desktop preview

Desktop runs Ask Agent chat without VS Code, and can also connect to an AgentLink VS Code window on the same Mac to view its existing sessions. Desktop supports Apple Silicon only; Intel Macs are no longer supported. The installer downloads the newest Apple Silicon DMG and opens it so you can drag **AgentLink** to Applications:

![The AgentLink Desktop app showing an Ask Agent conversation with chat history in the sidebar](docs/assets/screenshots/desktop-ask-agent.png)

<p>
  <img src="docs/assets/screenshots/desktop-quick-ask.png" alt="The Desktop Quick Ask prompt floating over VS Code, ready to send a question" width="49%">
  <img src="docs/assets/screenshots/desktop-vscode-view.png" alt="Desktop connected to a running VS Code window, showing that window's agent session and its pending command approval" width="49%">
</p>

```sh
curl -fsSL https://raw.githubusercontent.com/reefbarman/agentlink/main/scripts/install.sh | bash -s -- --surface desktop
```

You can also download the DMG from the [Desktop releases](https://github.com/reefbarman/agentlink/releases?q=desktop-v&expanded=true). Desktop binaries are not included in the VSIX.

This preview is unsigned and not notarised. macOS may require you to right-click **AgentLink**, choose **Open**, and confirm its first launch. See [Desktop setup and limitations](resources/builtin-skills/documentation/references/getting-started.md#standalone-desktop-preview).

### Try the standalone CLI preview

The CLI is a self-contained terminal coding agent for macOS Apple Silicon, with its own Node runtime, reviewed edits and commands, project sessions, and optional TypeScript/JavaScript intelligence. The installer verifies the SHA-256 checksum and links `~/.local/bin/agentlink`:

![The AgentLink CLI running a coding session in the terminal](docs/assets/screenshots/cli-tui.png)

```sh
curl -fsSL https://raw.githubusercontent.com/reefbarman/agentlink/main/scripts/install.sh | bash -s -- --surface cli
```

The CLI is unsigned and not notarised, supports neither Intel Macs nor Linux/Windows yet, and has a narrower tool set than the VS Code extension. See [CLI installation and setup](resources/builtin-skills/documentation/references/standalone-cli.md#github-release-preview) for manual installation and limitations.

### Build on the Node SDK preview

The `@agentlink/protocol`, `@agentlink/core`, and `@agentlink/node-host` libraries let you run the AgentLink agent loop inside your own Node server, for example as the core of a web agent. They are versioned together and published as GitHub Release archives (not npm yet). From your project directory:

```sh
curl -fsSL https://raw.githubusercontent.com/reefbarman/agentlink/main/scripts/install-sdk.mjs | node --input-type=module - --install
```

This vendors checksum-verified archives into `vendor/agentlink/` and adds them to `package.json`. The first SDK release is still pending; until then, vendor the libraries from a source checkout. See [Embedding AgentLink](resources/builtin-skills/documentation/references/embedding-agentlink.md).

### Start your first VS Code session

1. Reload VS Code and open the folder you want to work in.
2. Open **AgentLink** from the Activity Bar, then choose **Agent**.
3. Use the empty-chat card to sign in with ChatGPT/Codex, add an OpenAI API key, or configure another compatible provider.
4. Start with a bounded request:

   > Read this project, explain its main module boundaries, and identify the safest place to add `<feature>`.

5. Review diffs and approve commands as needed. Use `/checkpoint` before risky work and `/revert` if you want to undo it.

The [getting started guide](resources/builtin-skills/documentation/references/getting-started.md) covers source builds, platform details, first-run behavior, and next steps.

## Bring your own models and workflow

Choose ChatGPT/Codex, OpenAI, or an OpenAI-compatible provider. Connect the tools and services you already use through [MCP](resources/builtin-skills/documentation/references/mcp.md). Keep existing instructions, skills, commands, and compatible hooks in the conventions your projects already understand.

## What AgentLink is not

- It does not train or sell a proprietary model, and it does not put a cloud middleman between you and your provider account.
- It is not a VS Code fork—your extensions, marketplace, language tooling, and existing setup remain yours.
- The browser remote is for supervision: diffs are read-only there and it has no remote shell or write path.
- Some capabilities are still maturing, including best-of-N and scheduled automations. The [positioning article](why-agentlink.md) keeps the current rough edges explicit.

## Documentation

- [Getting started, including Desktop](resources/builtin-skills/documentation/references/getting-started.md)
- [Standalone CLI](resources/builtin-skills/documentation/references/standalone-cli.md)
- [Embedding AgentLink with the Node SDK](resources/builtin-skills/documentation/references/embedding-agentlink.md)
- [Capabilities overview](resources/builtin-skills/documentation/references/capabilities.md)
- [Tools](resources/builtin-skills/documentation/references/tools.md)
- [Customization](resources/builtin-skills/documentation/references/customization.md)
- [MCP](resources/builtin-skills/documentation/references/mcp.md)
- [Troubleshooting](resources/builtin-skills/documentation/references/troubleshooting.md)
- [Complete product reference](resources/builtin-skills/documentation/references/complete-reference.md)

## Contributing

AgentLink development requires Node.js 22.19 or newer and VS Code 1.109 or newer.

```sh
git clone https://github.com/reefbarman/agentlink.git
cd agentlink
npm install
npm run build
```

Press **F5** in VS Code to launch an Extension Development Host. Read the [development reference](resources/builtin-skills/documentation/references/complete-reference.md#development) before submitting a production change.

## Project links

[Releases](https://github.com/reefbarman/agentlink/releases) · [Issues](https://github.com/reefbarman/agentlink/issues) · [Changelog](CHANGELOG.md) · [License](LICENSE)
