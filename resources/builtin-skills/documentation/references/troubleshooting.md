# Troubleshooting AgentLink

Use this guide for common setup and runtime problems. For exact settings and limits, use the [package contract](package-contract.md).

## I cannot install AgentLink

- Make sure the `code` command is available for the VS Code installation you want to use.
- Download the VSIX that matches the machine running the VS Code extension host, not necessarily the machine where you typed the command.
- For remote or emulated hosts, set `AGENTLINK_VSCE_TARGET` explicitly when using the installer.
- If you install manually, run `code --install-extension agentlink-*.vsix --force`, then reload VS Code.

See [installation](getting-started.md#install) for commands and [platform notes](complete-reference.md#platform-notes) for target details.

## Desktop or CLI preview will not open on macOS

Desktop and CLI GitHub releases are unsigned and not notarised. Download the build for your Mac (Desktop: Apple Silicon or Intel; CLI: Apple Silicon only). For Desktop, open the DMG, drag the app to Applications, then right-click **AgentLink** and choose **Open** if macOS warns about the first launch. For CLI, verify the archive against its release `.sha256` file before extracting, keep the extracted directory intact, and run its `bin/agentlink` launcher. See [Desktop setup](getting-started.md#standalone-desktop-preview) and [CLI installation](standalone-cli.md#github-release-preview). The local development-signed CLI installer deliberately rejects the unsigned public preview archive.

## The chat says a model needs setup

Use the setup action shown in the empty chat:

- **Continue with ChatGPT/Codex** signs in with ChatGPT/Codex.
- **Use OpenAI API key** opens secure credential setup for the first-class OpenAI provider.
- **Configure another provider** opens guided OpenAI-compatible setup for every other provider.

A configured credential does not prove the provider request will succeed. Check quota, billing, network access, and whether the key was revoked if the first request fails. Browser workspace chats show the same readiness but direct credential changes to the owning VS Code window.

For OpenAI-compatible setup, see [the complete reference](complete-reference.md#configure-openai-compatible-models).

## Changing models mentions unsaved User Settings

Current AgentLink releases save picker defaults in `~/.agentlink/session-preferences.json`, not VS Code User Settings. VS Code imports older AgentLink defaults once, then model, mode, thinking-level, and compaction changes should not touch `settings.json`.

If an installed build still says it could not save a shared default because User Settings has unsaved changes, reload every VS Code window after updating and confirm the new extension version is active in each window. The message comes from the older User Settings persistence path.

## My ChatGPT/Codex accounts disappeared after updating on macOS

AgentLink now uses a shared macOS Keychain account pool for VS Code, AgentLink Desktop, and helper-owned Browser Ask Agent. Legacy OAuth credentials that existed only in VS Code SecretStorage are deliberately not imported or deleted. Sign in again from VS Code or **AgentLink Desktop > Manage Accounts**; subsequent account additions, active-account changes, sign-outs, refreshes, and usage-limit rotation are shared on that Mac.

If Keychain is locked or unavailable, AgentLink fails closed and keeps the stored account data intact. Unlock Keychain and retry rather than repeatedly adding the account. macOS may ask once for each distinct AgentLink host executable (for example VS Code and AgentLink Desktop). AgentLink caches successful reads within each host and uses a non-secret local revision marker to notice account changes from another surface, so reopening account menus should not repeatedly access Keychain; continued prompts from the same host after choosing **Always Allow** indicate a Keychain access-control problem rather than a missing login.

## A GPT-6 model is selected but the request fails

AgentLink lists GPT-6 Astra, GPT-6.1 Sol, and GPT-6 Luna for ChatGPT/Codex OAuth and OpenAI API-key users without probing whether the current subscription account or API project has rollout access. If access is not enabled yet, AgentLink leaves the selected model unchanged and shows the provider's normal error instead of silently changing models or credentials.

- Confirm the intended ChatGPT account or OpenAI API project has access to the selected model and available quota. OpenAI announced a gradual same-day rollout for Sol and Luna, so a newly released model may appear later for some accounts.
- The ChatGPT backend can return `The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account` after that account exhausts its Codex allowance. AgentLink treats that exact contradiction as a usage limit, rotates to another signed-in account when available, and otherwise shows usage-limit guidance instead of repeating the misleading provider message.
- A body-less OAuth `400` does not by itself prove an entitlement problem; it can also represent another ChatGPT/Codex backend rejection. For Astra, AgentLink identifies that exact failure, confirms that it sent the Responses Lite contract, explains that the server supplied no exact reason, and includes the OpenAI request ID or Cloudflare Ray when the response exposes one.
- OAuth exposes Astra's `ultra` preset and sends its catalog-mapped `xhigh` wire effort through Codex's Responses Lite transport. API-key requests clamp a saved `ultra` preference to `max`, and the UI shows that effective effort.
- AgentLink budgets OAuth Astra against Codex's 872K catalog maximum context window; the bundled 272K value is the CLI's smaller base window, not its maximum.
- AgentLink does not retry a different account specifically for Astra entitlement, switch to an API key automatically, or remap Astra to another model.
- GPT-6.1 Sol replaced GPT-6 Sol, and saved GPT-6 Sol selections migrate to it. If your account does not have GPT-6.1 Sol yet, pick another model; AgentLink does not fall back to GPT-6 Sol automatically.

## Fast or Ultrafast does not seem faster

The Speed control only applies to models that offer OpenAI's premium service tiers: Fast on GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol, GPT-6 Luna, GPT-5.6 models, and GPT-5.5, and Ultrafast on GPT-6 Astra only. It is hidden for other models, and a session tier the current model does not support runs at Standard. ChatGPT subscriptions allow premium tiers only on eligible plans, and OpenAI supports Ultrafast only for US or global processing. When the endpoint rejects a tier (including a body-less ChatGPT `400` while a premium tier was requested), AgentLink retries that request once at standard speed, records the `service_tier` rejection in the AgentLink output log, and skips that tier for that account and model until the window reloads. A rejected Ultrafast does not stop Fast from being tried. Each request's log line shows `serviceTier=priority` (Fast), `serviceTier=ultrafast`, or `serviceTier=default`. OpenAI recommends WebSocket transport for the full latency benefit. AgentLink prefers WebSockets for supported first-party Responses requests; expand the request details to check the actual transport. HTTP/SSE may indicate an explicit disable, an unsupported endpoint/history shape, or automatic fallback. See [transport and recovery](capabilities.md#models-and-providers).

## AgentLink has no workspace tools

Open a folder or workspace in VS Code. Projectless chats intentionally have no workspace files, path attachments, shell, editor tools, MCP, checkpoints, or approval controls.

## Codebase search is unavailable or incomplete

- Open a workspace folder.
- Check that local codebase indexing is enabled and allowed to finish.
- Local lexical and structural retrieval run on-device without credentials.
- Vector and hybrid retrieval additionally require OpenAI embedding credentials and an explicit `agentlink.semanticEmbeddingsEnabled: true` opt-in.
- Check the query result's `ranking`, `ranking_reason`, and `guidance`. `embeddings_disabled` means intentional local lexical search. Embedding HTTP/network failures point to service availability or credentials; missing, unavailable, or unhealthy indexes point to local setup, repair, or rebuild. Keyword fallback remains usable while those problems are addressed.
- Snapshot and fixture paths are downweighted, not hidden. Use query-mode `exclude_globs` when those files are out of scope, or narrow `path` to the relevant source directory.

See [indexed query search setup](complete-reference.md#code-search-setup).

## Workspace indexes use too much disk space

In VS Code, run **AgentLink: Manage Index Storage** from the Command Palette, even when indexing is disabled. It lists current-generation workspace caches and their file sizes. Older caches without workspace identity metadata may appear as **Unknown workspace**.

- **Compact and prune** performs database-aware maintenance while retaining one hour of table history. It preserves indexed content and may not reclaim every orphan file.
- **Remove workspace index** deletes the selected cache and matching index metadata, not source files. Search for that workspace is unavailable until it is indexed again. Enabled embeddings may incur regeneration cost.
- Close all other VS Code and AgentLink windows before either action, then confirm in the dialog. The current workspace and stores with live writer processes are blocked. This local maintenance command is not available through browser remote.
- Normal indexing maintains existing search indexes rather than replacing every index after each change. Automatic pruning still retains recent versions for concurrent readers. Do not manually remove files inside a LanceDB table by age.

## A sandbox helper failed during a command

- Read the `sandbox_helper_failed` result's failure category and launch evidence. `unknown` means AgentLink cannot establish whether the command started, not that retrying is safe.
- Pass its `terminal_id` and `command_id` to `get_terminal_output` to inspect the retained command, not a newer command in the same terminal. The failure result's output is only a bounded preview.
- Check whether the command changed files or remote state before deciding on a new execution. A helper failure never authorises automatic replay or native fallback.
- For `protected_git_metadata`, use the exact reviewed native option. Temporary HOME cannot fix protected Git lock writes, including linked-worktree locks. An interactive Git staging command can exit zero after printing `git apply` failed. Treat the accompanying `failure_evidence` as a failed staging step and inspect the index before retrying, since some hunks may already have been staged.

## A command or edit is waiting for approval

That is expected when the requested action crosses a configured boundary. Review the operation, edit it or add a follow-up if necessary, then approve or reject it. Use command/path/write rules only when you understand the scope they grant.

For approval behavior and rules, see [approvals](capabilities.md#approvals) and [the complete approval reference](complete-reference.md#approval-system).

## A sandboxed command failed with permission or TLS errors

Follow the returned `retry_guidance` rather than changing permissions or replaying the command blindly. AgentLink distinguishes narrow TCP listener access from Unix IPC, keeps Docker/Colima sockets behind reviewed native execution, and never recommends disabling TLS verification. A disposable `temporary_home` is suitable only when the failed step does not need your normal credentials or configuration. For a host-HOME write denial in a credential-dependent command, choose the separately reviewed native option instead; it preserves your host HOME but runs outside the sandbox only after independent approval. For compound commands, confirm which step failed and retry that step alone because earlier steps may already have succeeded. If Turbopack still reports a listener denial after local binding was granted, use the unresolved-capability guidance rather than repeating the same grant.

An npm cache denial under `~/.npm/_cacache/tmp` is still a host-HOME write denial, not a write to the system `/tmp` directory. Its recovery guidance follows the same credential requirements above. If the command or failure output identifies mise/asdf shims, a disposable HOME can lose toolchain trust state too; use the separately reviewed host-HOME option instead of automatically trusting the host configuration. An unrelated shim directory on PATH alone does not establish that dependency.

- For `sandbox_protected_root_drift`, inspect the reported snapshot change and retry with a new preparation. If changes continue, resolve the concurrent mutation before retrying. This does not authorise native bypass.
- For a symbolic-link lock in `.git/worktrees/`, check its owner and keep live locks intact. Use the exact separately reviewed native option when offered, not lock deletion as a workaround.
- For Docker socket denials in deferred tests, collect finalized output with both command and terminal IDs. Eligible results include failed-step native guidance; it never changes socket permissions or replays successful prefixes.
- For `managed_network_connect_timeout`, curl's timing evidence says no connection or TLS handshake was established, not that the provider was slow or the proxy was necessarily broken. Inspect managed connectivity or request a reviewed native connectivity check without disabling TLS verification.

## An approved edit failed to save or conflicts with unsaved work

- Do not overwrite or discard the dirty editor to clear the error. Both `read_file` views (content and context) show disk content, which can differ from the unsaved buffer.
- Ask the VS Code workspace agent to inspect `get_editor_state`, then use `save_editor` with the returned hashes/version if the existing buffer is correct. You must approve the exact save once; it skips formatting and preserves the buffer on rejection. These tools only work for an open file-backed target editor. If a review retained a stale, closed, or non-file buffer, inspect it directly in VS Code before closing it, then re-open the target and compose the edit again after reconciling the buffer.
- If the buffer contains unrelated or incorrect edits, reconcile it in VS Code first. State changes invalidate the old save request.
- Large files/diffs or protected instructions require native editor or instruction-workflow handling. The tools cannot repair a filesystem/save-participant failure; a failed recovery still reports failure and preserves unsaved work where VS Code allows it.

See [editor recovery tools](tools.md#recover-unsaved-editor-changes) for limits and surfaces.

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

- **`sandbox_unavailable`, runtime unavailable:** check `agentlink.terminal.nodePath` on the host. Replace a removed version-specific Node executable with an existing standalone Node path, or clear the setting to allow discovery. Reload the owning VS Code window after repair to clear cached runtime resolution, then retry. Eligible default Approve for Me requests can still offer one exact native approval; sandbox-only capability requests cannot.
- **Failed sandbox security/trust check:** inspect the returned `sandbox_diagnostic.category` (when available) and the AgentLink output channel. Verify the installed extension/runtime assets and workspace trust. Repair the host setup before retrying. Raw probe output is not returned to the agent, and neither failed checks nor invalid grants permit native bypass.
- **Sandbox feature/host unavailable:** `feature_disabled` means enable `agentlink.terminal.enabled` on the owning host. `remote_host` and `unsupported_host` mean this sandbox request requires a supported local macOS extension host. Node-path changes or repeated reloads cannot add sandbox support to an unsupported host.
- **`sandbox_capability_launch_failed`, `compile_failed`:** stop repeating the command. Check the requested capabilities, command environment and host sandbox policy for mismatches before checking installed runtime assets. The AgentLink output channel records the bounded `compile_failed` reason, not the raw compiler exception. Correct the identified request, policy or runtime problem, then request a fresh reviewed execution. Do not assume reinstalling will fix an invalid request, reuse failed grants or broaden permissions.
- **Native dispatch ended without script confirmation:** a shell-wrapper start is not proof the approved script was consumed. A completed unconfirmed result reports `failure_stage: "launch"`, leaves `process_launched` unspecified, and sets `retry_safe: false`. Inspect the captured launch diagnostic and any local or remote effects before requesting a new execution. Do not repeat a mutation merely because the wrapper ended or the final exit code is unavailable. Launch diagnostics remain available through the normal retained-output path without marking the command ready.
- **`native_shell_startup_timeout`:** no command launched, and the failed terminal is closed. Check the selected host terminal profile in a normal VS Code terminal for startup prompts or hangs, including `.zshrc`/`.bashrc` and toolchain initialisers. Repair startup before retrying in a new terminal. Reloading alone does not repair a shell startup blocker; AgentLink does not silently bypass your startup files.
- **`sandbox_preparation_failed`:** no command launched. `reserved_path_override` means remove `env.PATH` and use an inline `export PATH="/desired/bin:$PATH" && command` instead. `reserved_environment_override` means remove host-managed overrides (for example HOME, temporary directories, proxy settings, or loader settings). `unsupported_shell_profile` means the host's `agentlink.terminal.shellEnvironment.useProfile` setting is unsupported by the attested helper and must be disabled before a fresh reviewed execution. Generic `preparation_failed` requires checking managed terminal availability, the requested environment, capabilities, workspace/protected-path integrity, and host policy. Untyped integrity failures stay blocked under this generic category. The output channel records only the bounded category, not raw exceptions or environment values. These are preparation failures, not failed availability attestations; they never permit native bypass or automatic replay.
- **An exported `PATH` disappeared:** sandbox calls use fresh shells even in named or targeted terminals. Include `export PATH="/desired/bin:$PATH" && command` in each reviewed sandbox call, or combine dependent steps in one command. `env.PATH` is reserved and rejected. Only named/targeted Native Agent terminals retain intentional shell changes.

For terminal requirements, recovery codes, and the custom AgentLink Terminal, see [the complete reference](complete-reference.md#agentlink-terminal) and [tool reference](tools.md#run-and-inspect-commands).

## I need a complete technical reference

The [complete product reference](complete-reference.md) remains the comprehensive compatibility reference while focused guides are being split out. Use it when a focused guide does not yet cover the required detail.
