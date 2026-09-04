# Troubleshooting AgentLink

Use this guide for common setup and runtime problems. For exact settings and limits, use the [package contract](package-contract.md).

## I cannot install AgentLink

- Make sure the `code` command is available for the VS Code installation you want to use.
- Download the VSIX that matches the machine running the VS Code extension host, not necessarily the machine where you typed the command.
- For remote or emulated hosts, set `AGENTLINK_VSCE_TARGET` explicitly when using the installer.
- If you install manually, run `code --install-extension agentlink-*.vsix --force`, then reload VS Code.

See [installation](getting-started.md#install) for commands and [platform notes](complete-reference.md#platform-notes) for target details.

## The chat says a model needs setup

Use the setup action shown in the empty chat:

- **Continue with ChatGPT/Codex** signs in with ChatGPT/Codex.
- **Use OpenAI API key** opens secure credential setup for the first-class OpenAI provider.
- **Configure another provider** opens guided OpenAI-compatible setup for every other provider.

A configured credential does not prove the provider request will succeed. Check quota, billing, network access, and whether the key was revoked if the first request fails. Browser workspace chats show the same readiness but direct credential changes to the owning VS Code window.

For OpenAI-compatible setup, see [the complete reference](complete-reference.md#configure-openai-compatible-models).

## GPT-6 Astra is selected but the request fails

AgentLink lists `gpt-6-astra` for ChatGPT/Codex OAuth and OpenAI API-key users without probing whether the current subscription account or API project has rollout access. If access is not enabled yet, AgentLink leaves Astra selected and shows the provider's normal error instead of silently changing models or credentials.

- Confirm the intended ChatGPT account or OpenAI API project has Astra access and available quota.
- A body-less OAuth `400` does not by itself prove an entitlement problem; it can also represent another ChatGPT/Codex backend rejection. For Astra, AgentLink identifies that exact failure, confirms that it sent the Responses Lite contract, explains that the server supplied no exact reason, and includes the OpenAI request ID or Cloudflare Ray when the response exposes one.
- OAuth exposes Astra's `ultra` preset and sends its catalog-mapped `xhigh` wire effort through Codex's Responses Lite transport. API-key requests clamp a saved `ultra` preference to `max`, and the UI shows that effective effort.
- AgentLink budgets OAuth Astra against Codex's 872K catalog maximum context window; the bundled 272K value is the CLI's smaller base window, not its maximum.
- AgentLink does not retry a different account specifically for Astra entitlement, switch to an API key automatically, or remap Astra to another model.

## AgentLink has no workspace tools

Open a folder or workspace in VS Code. Projectless chats intentionally have no workspace files, path attachments, shell, editor tools, MCP, checkpoints, or approval controls.

## Codebase search is unavailable or incomplete

- Open a workspace folder.
- Check that local codebase indexing is enabled and allowed to finish.
- Local lexical and structural retrieval run on-device without credentials.
- Vector and hybrid retrieval additionally require OpenAI embedding credentials and an explicit `agentlink.semanticEmbeddingsEnabled: true` opt-in.

See [semantic codebase search setup](complete-reference.md#semantic-codebase-search-setup).

## A command or edit is waiting for approval

That is expected when the requested action crosses a configured boundary. Review the operation, edit it or add a follow-up if necessary, then approve or reject it. Use command/path/write rules only when you understand the scope they grant.

For approval behavior and rules, see [approvals](capabilities.md#approvals) and [the complete approval reference](complete-reference.md#approval-system).

## The browser remote cannot do something VS Code can

The browser is a supervision surface. It can view sessions, questions, background activity, and read-only diffs, but it intentionally has no remote shell or write/edit path. Use the owning VS Code window for changes and terminal work.

See [browser remote control](capabilities.md#browser-remote-control).

## An MCP server is offline or keeps requesting authentication

Saving configuration and connecting are separate. Confirm the server command or URL, then use `/mcp` to inspect status or `/mcp-refresh` to reconnect. HTTP OAuth flows are coordinated across windows; use **Reauthenticate** when AgentLink offers it rather than repeatedly reloading configuration.

See [MCP](mcp.md).

## An Agent Plugin will not load

Agent Plugins load on macOS and Linux only. Check the manager diagnostics, review the package source and declared commands, and remember that projectless sessions do not load plugin components. Windows plugin loading is currently disabled.

See [Agent Plugins](customization.md#agent-plugins).

## A terminal tool call hangs or times out

AgentLink reports recognized launch and environment failures with structured recovery guidance. Foreground commands stopped at an interactive prompt return prompt evidence instead of waiting forever; background commands remain observable through their retained output.

For terminal requirements, recovery codes, and the custom AgentLink Terminal, see [the complete reference](complete-reference.md#agentlink-terminal) and [tool reference](tools.md#terminal-and-command-tools).

## I need a complete technical reference

The [complete product reference](complete-reference.md) remains the comprehensive compatibility reference while focused guides are being split out. Use it when a focused guide does not yet cover the required detail.
