# Getting Started with AgentLink

AgentLink is a coding-agent harness built into VS Code. It gives an agent the editor's language intelligence, reviewable diffs, visible terminal work, and approvals you can tune to the task.

## Install

### From a GitHub release

Use the installer to download the VSIX for the machine running the VS Code extension host:

```sh
curl -fsSL https://raw.githubusercontent.com/reefbarman/agentlink/main/scripts/install.sh | bash
```

For a remote or emulated extension host, specify the target explicitly:

```sh
curl -fsSL https://raw.githubusercontent.com/reefbarman/agentlink/main/scripts/install.sh \
  | AGENTLINK_VSCE_TARGET=linux-x64 bash
```

You can also download the matching `.vsix` from the [latest release](https://github.com/reefbarman/agentlink/releases/latest) and install it yourself:

```sh
code --install-extension agentlink-*.vsix --force
```

The installer supports `darwin`, `linux`, `alpine`, and `win32` targets on `arm64` and `x64`. See the [complete reference](complete-reference.md#installation) for source builds, platform details, and AgentLink Terminal requirements.

### Standalone desktop preview

AgentLink Desktop is a separate macOS application. Its **Ask AgentLink** view runs without VS Code or the extension and shares global `~/.agentlink` configuration and macOS Keychain accounts with other AgentLink surfaces when they are installed on the same Mac.

Use the desktop sidebar to switch between **Ask AgentLink** and **VS Code**. VS Code connects to the running local AgentLink browser gateway and displays its existing workspace tabs, chats, and review panes without desktop restyling. Both views stay mounted when switching, preserving drafts and selected tabs. If no gateway is available, open VS Code with AgentLink and use **Reconnect**; restarting the gateway reloads the remote view. Desktop never starts or replaces the VS Code gateway and does not gain extra remote shell or file-writing permissions. External windows, downloads, and browser permission requests are blocked in the isolated view; complete MCP URL-opening requests in VS Code or the regular browser gateway. Older extension builds may still show their original browser header and Ask Agent tab until updated.

The desktop chat uses AgentLink's interlocking-link logo in the title bar and welcome screen, a dark teal palette with subtle teal/violet accents, softly tinted welcome cards, a compact gradient-edged composer, and a collapsible chat sidebar. The theme is independent of your editor; interactive hover effects respect reduced-motion preferences. Use **Search chats** to filter saved conversations and **Manage chats** to rename or delete them. The sidebar opens by default in wider windows; toggle it beside the app title. The title-bar **More** menu contains **Memory**, **File access…** (local read permissions), and **Continue in VS Code**. **New chat** and **Manage chats** live in the sidebar; when it is collapsed, **New chat** appears in the title bar and **Manage chats** is available under **More**. Desktop shows streaming activity in the transcript rather than repeating it in a status bar above the composer. Questions and approval cards remain visible near the input, with desktop-matched styling. The browser gateway shares this styling and Ask Agent / VS Code sidebar navigation, with a collapsed sidebar on mobile. Workspace views retain their existing VS Code-style layout. Browser settings and notifications remain available; native Work mode is reserved for the desktop and is not available in the browser.

Download the DMG or ZIP matching your architecture from a `desktop-v*` [GitHub release](https://github.com/reefbarman/agentlink/releases). Desktop artifacts have their own version and release workflow; they are never included in the VSIX. The current preview is unsigned and not notarized, so the first launch may require right-clicking **AgentLink**, choosing **Open**, and confirming macOS's warning.

## Start your first session

1. Reload VS Code and open the folder you want to work in.
2. Select the **AgentLink** icon in the Activity Bar, then open **Agent**.
3. Follow the empty-chat setup card:
   - **Continue with ChatGPT/Codex** starts the recommended sign-in path.
   - **Use OpenAI API key** opens secure credential setup for the first-class OpenAI provider.
   - **Configure another provider** opens guided OpenAI-compatible model setup for every other provider.
4. Give the agent a bounded first task, for example:

   > Read this project, explain its main module boundaries, and identify the safest place to add `<feature>`.

5. Review proposed diffs and approve commands when AgentLink asks. Use `/checkpoint` before risky work and `/revert` when you need to undo a workspace change.

A configured credential means AgentLink is ready to try the provider. The first request can still fail because of provider-side connectivity, quota, billing, or a revoked key. Your draft remains available while setup is incomplete.

## Know the boundaries

With a workspace folder open, AgentLink can use editor, terminal, MCP, approval, and codebase tools. Without one, it is deliberately limited to a non-persistent Ask-only chat: no workspace files, shell, editor tools, MCP, checkpoints, or approvals.

The browser remote can supervise sessions, answer questions, and inspect read-only diffs. It has no remote shell or write path.

## Good first workflows

- Ask for an explanation or a safe plan before asking for a change.
- Use **code** mode to implement, **architect** to plan, **debug** to investigate, and **review** for focused review.
- Attach a file or selection from the editor instead of pasting it.
- Use `/model` to switch models and `/mode` to switch workflows without starting over.
- Use `/checkpoint` and `/revert` for reversible experimentation.

## Next steps

- [Capabilities overview](capabilities.md) — what AgentLink can do.
- [Models, providers, and advanced setup](complete-reference.md#quick-start) — including OpenAI-compatible connections.
- [MCP](mcp.md) — connect the services and tools your workflow already uses.
- [Customization](customization.md) — instructions, skills, hooks, plugins, and memory.
- [Troubleshooting](troubleshooting.md) — common setup and runtime problems.
