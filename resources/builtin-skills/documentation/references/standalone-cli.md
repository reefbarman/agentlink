---
name: standalone-cli
description: Install, configure, and use the private macOS Apple Silicon AgentLink CLI preview. Use for standalone CLI tarballs, terminal coding chat, reviewed file edits and commands, managed TypeScript or JavaScript language intelligence, LSP installation and status, diagnostics, symbols, definitions, references, hover, instructions, skills, MCP configuration, trust, credentials, OAuth, sessions, storage, cancellation, or current limits.
---

# Standalone AgentLink CLI

The private standalone CLI preview runs a local multi-turn AgentLink coding session without VS Code or Electron. It supports provider setup, durable project sessions, project-relative file inspection, terminal-reviewed single-file edits, reviewed non-interactive commands with observable retained processes, trusted instructions and skills, approved stdio or HTTPS MCP tools, up to two scoped background writers, and optional managed TypeScript/JavaScript language intelligence.

## Requirements and packaging

- macOS on Apple Silicon.
- Node.js 22.19.0 or newer.
- An interactive terminal for coding chat and credential entry.
- Public npm registry access when installing the tarball, because `@napi-rs/keyring` is an exact runtime dependency.

Exercise the source-build TUI in real colour and no-colour PTYs, including resize, keyboard controls, Ctrl+Z/SIGCONT job control, Ctrl+C exit, and terminal restoration:

```sh
npm run smoke:tui --workspace @agentlink/cli
npm run smoke:tui:no-color --workspace @agentlink/cli
```

Build the private tarball, verify its exact dependency/licence/native-asset closure, install it outside the checkout, and run the installed no-colour PTY smoke:

```sh
npm run cli:smoke
```

The tarball is written under `apps/cli/artifacts/`. Install it globally, replace an existing preview with a newly built tarball, or uninstall it with:

```sh
npm install --global /path/to/agentlink-cli-0.1.0.tgz
npm install --global /path/to/new-agentlink-cli-0.1.0.tgz
npm uninstall --global @agentlink/cli
```

The package uses an exact file allowlist, bundles the private AgentLink JavaScript and pinned darwin-arm64 ripgrep binary, and includes generated third-party notices for every bundled npm package and ripgrep. `@napi-rs/keyring` 2.0.0 remains the only runtime npm dependency, so installation requires public registry access for its Darwin ARM64 native package. The installed CLI has no runtime dependency on unpublished `@agentlink/*` packages, the repository checkout, VS Code, or Electron. Optional TypeScript/JavaScript support is downloaded and managed separately.

## Provider setup

ChatGPT/Codex subscription OAuth:

```sh
agentlink auth codex
```

OpenAI API key:

```sh
agentlink auth openai
agentlink config model openai/gpt-5.6-sol
```

Configure one OpenAI-compatible endpoint:

```sh
agentlink config compatible PROVIDER_ID BASE_URL MODEL_ID CONTEXT_TOKENS OUTPUT_TOKENS
agentlink config model PROVIDER_ID/MODEL_ID
```

Append `no-auth` only for an endpoint that genuinely requires no API key. API keys and OAuth accounts are stored in the shared macOS Keychain service. Endpoint/model metadata is stored under `~/.agentlink/cli/config.json`; secrets are never written there. `AGENTLINK_HOME` changes the CLI data root for development or testing but does not change the shared Keychain service.

## Sessions

Start or resume the most recently updated session for the current canonical project directory:

```sh
agentlink --project /path/to/project
```

Resume an exact session or manage saved sessions:

```sh
agentlink --project /path/to/project --session SESSION_ID
agentlink sessions --project /path/to/project
agentlink delete SESSION_ID --project /path/to/project
```

Launch commands use Commander for standard nested help and validation. Run `agentlink --help` for the command list or `agentlink help COMMAND` for one command group. An incomplete group such as `agentlink auth` shows its valid subcommands, nearby misspellings produce suggestions, and missing required values show the relevant command usage without starting host state.

Interactive chat starts with a compact AgentLink-branded composer and expands into the full-screen Ink interface after the first submission or live session activity. The expanded interface has a bounded row-aware Markdown transcript, activity shelf, and multiline composer. `Enter` sends; `Ctrl+J`, `Shift+Enter`, `Alt+Enter`, and supported `Ctrl+Enter` insert a newline. `Tab` and `Shift+Tab` move between the composer, transcript, and activity shelf. When the transcript is focused, arrows scroll by one row, Page Up/Down scroll by one viewport, Home/End jump to the oldest/latest view, and Enter expands or collapses the newest visible tool group. Tool groups are collapsed by default and hide input/result JSON until expanded. When the activity shelf is focused, Up/Down select a section, Home/End select the first or last section, and Enter or Space toggles detail expansion. `Ctrl+T` jumps directly to the expanded TODO list. Streaming, animated working state, thinking blocks, tool blocks, and activity updates render in place without writing through the composer.

The bounded activity shelf appears only when there is relevant state. It can show provider token usage, active turn and tool work, the current session TODO, queued foreground messages, noteworthy retained commands, active structured questions, pending foreground and background approvals, and background-agent state. Expanding a row reveals recent tool details, execution counts, queued prompt text, the full TODO list, command IDs, question text, approval summaries, or agent task/current-tool information. The shelf reserves no space when empty and only a small bounded share when collapsed, so the transcript keeps usable space and the composer remains editable while work is active. Assistant Markdown renders headings, emphasis, inline code, fenced code, lists, blockquotes, links, and tables as terminal UI rather than exposing source markers. Blank lines separate Markdown blocks, two trailing spaces or a backslash preserve an explicit line break, and an ordinary newline inside a paragraph remains a soft break. Table columns share the available width equally and truncate long cells in narrow terminals.

Press `Ctrl+O` to open the control centre without memorizing commands. It provides keyboard-only access to background approvals, retained processes and stop actions, background agent steering/stopping, session switching, model and reasoning selectors, current mode/write-policy availability, and shortcut help. In review and control panels, Up/Down changes selection, Page Up/Down scrolls long details, Enter confirms, and Escape cancels where cancellation is safe. Foreground file, command, and MCP proposals open automatically when a turn suspends; structured `ask_user` questions and MCP launch, network, and OAuth reviews use the same panel. File/command session grants and exact command rules remain available, and background command launches still require typing `allow background` before the process can start.

Type `/` for command completion. Selecting an action command from completion runs it immediately. Inside chat, use `/new`, `/sessions [SESSION_ID]`, `/model`, `/reasoning` (or `/thinking`), `/mode`, `/processes`, `/output COMMAND_ID`, `/stop COMMAND_ID`, `/agents`, `/approvals`, `/agent-steer CHILD_ID MESSAGE`, `/agent-stop CHILD_ID`, `/help`, and `/exit`. `/sessions` lists project sessions; `/sessions SESSION_ID` switches and hydrates an exact session while idle. `/model` uses the maintained AgentLink provider catalogue and displays readiness plus supported reasoning levels. `/reasoning` shows only the selected model's supported levels and marks its default. Both persist settings for the current idle session. The standalone host currently exposes only code mode and prompt-on-ungranted-write policy, so those controls report the active capability rather than pretending broader support. Type `@` to select up to four project-file attachments, or paste one project file path. Real paths are resolved inside the project with 10 MB per-file and 20 MB total limits. Valid UTF-8 text files are inlined into the prompt, images and PDFs are forwarded as model media, and all attachments appear in the transcript. Supported Kitty, iTerm2, and Sixel terminals can render image previews; other terminals retain a filename and text/image fallback. Raw clipboard image bytes are not available through ordinary terminal paste, so paste the saved image path instead. Up/Down at the empty composer boundary navigates up to 100 unique submitted prompts. Press Ctrl+C during a turn or approval to cancel it; press it while idle to exit. Press Ctrl+Z to hand terminal ownership back to the shell, then run `fg` to resume AgentLink with a full redraw.

The TUI uses the terminal's alternate screen. It restores raw mode, cursor visibility, bracketed paste, and the prior screen on normal exit, render failure, Ctrl+C, and Ctrl+Z suspend/resume. In-TUI review promises and queued questions are cancelled during shutdown instead of remaining unresolved. Set `NO_COLOR=1` to disable colour without changing layout or controls. Sessions, transcripts, command metadata, child outcomes, and bounded retained output are private local state partitioned by canonical project identity. A prior process that stopped mid-turn is marked interrupted before the session continues.

### Terminal limitations

- Coding chat requires an interactive TTY with standard ANSI alternate-screen, cursor, and bracketed-paste support. Non-interactive status, setup, and help commands remain available.
- Very narrow or short terminals intentionally truncate transcript, activity, and control details so the composer remains usable. Page Up/Down and detail expansion expose bounded content where supported.
- Full-width, emoji, and combining-character layout depends on the terminal emulator's Unicode width reporting and selected font. Unusual combinations can align differently even though text remains intact.
- Copying uses the terminal emulator's ordinary selection. There is no mouse-only UI, embedded shell, interactive subprocess PTY attachment, inline image/PDF rendering, or Windows/Linux terminal support in this preview.

## Read and edit files

The CLI exposes project-relative `read_file`, `list_files`, `search_files`, and `get_context` tools. Results are bounded, `.git` and `node_modules` are ignored, environment files are withheld, and `get_context` returns the SHA-256 hash used as the saved-file baseline for an edit.

`write_file` replaces one file and `apply_diff` applies canonical, uniquely matching SEARCH/DIVIDER/REPLACE blocks to one file. Existing files require the exact baseline hash; new files require an explicit absent-file precondition. Before writing, the terminal shows the complete resulting diff, baseline and proposed hashes, file size, and protected-path status. You can approve once, continue the same tool on that unprotected path along the verified content-hash chain for the current session, or deny. The session grant is bound to the tool, path, scope, policy revision, and last verified committed hash. External edits or switching between patch and replacement require a fresh review. Session grants do not cross `/new` sessions or process restarts, and protected instruction or authority files always require a fresh human approval.

Approval is bound to the exact canonical tool input, project, path scope, baseline, proposed content, and policy revision. The host rechecks these before a restored proposal is shown and again before an allow is applied. A changed file, changed scope, alias, hard link, or unsafe parent rejects the proposal without overwriting the current file. Successful writes include the verified final SHA-256 hash and exact durability evidence.

Only one CLI writer can own the same or an overlapping canonical project root at a time. The private ownership registry coordinates participating CLI processes only. It does not lock out VS Code, other editors, or external tools. Conflicts are detected against saved files; unsaved editor buffers are invisible, and there is no multi-file atomicity promise.

## Commands and processes

`execute_command` runs through an absolute non-login `/bin/zsh -c` launch with the exact approved command, canonical project-contained working directory, and a complete host-resolved environment. Environment values are omitted from approval metadata and prepared-launch persistence. Pending approvals retain only variable names and a host-keyed digest, then re-resolve and verify the environment immediately before launch. If a command prints the value of a credential-like environment variable, the supervisor redacts that value before retaining or returning output. Commands do not have a PTY, stdin is closed, and shell state does not carry between calls. Command approval is not a sandbox and does not limit filesystem or network effects.

Every unmatched command is reviewed manually. The terminal shows the command, executable and arguments, working directory, timeout, environment variable names, and unsandboxed status. For a foreground command you can allow once, allow that exact command/cwd/mode for the current session, save an exact durable allow rule, or deny. Exact forbidden or prompt rules remain authoritative, and changing command policy or shell configuration invalidates a pending launch. Restored approvals require a fresh human decision and execute only the previously prepared launch.

Foreground commands hold an exclusive project mutation window for their observed lifetime, while ordinary file commits may run concurrently with each other. Background mode is reserved for long-lived development processes. It always requires typing `allow background` to acknowledge that the exact unsandboxed process may modify files while editing continues, even if an allow rule exists. Session and durable allow-rule choices are not offered for this exception. This is coordination, not confinement. Background processes stay owned by the foreground session, including processes requested by a child, retain bounded interleaved stdout/stderr under a stable command ID, and can be listed, observed, or stopped. Stop, timeout, and cancellation signal the process group with TERM followed by bounded KILL escalation. If termination cannot be confirmed, the command remains observable as interrupted instead of being reported as cancelled. On restart, a previously running record becomes interrupted; the CLI never reconnects to, kills, or replays the old PID.

## Background writers

The foreground agent can start at most two native child sessions with `spawn_background_agent`. Each spawn supplies explicit project-relative read and write paths. Child authority is the intersection of those paths and the parent session's current file scopes. Sibling write paths must be disjoint, and the parent cannot write through a live child reservation. Scope is rechecked before child reads, approval, and physical writes, so parent scope revocation fails closed. Children inherit the parent's selected model and reasoning setting unless the spawn explicitly selects another configured model.

Children are one level deep and never receive delegation tools. They run as independent durable core sessions, can edit disjoint files concurrently, and expose bounded lifecycle, phase, current-tool, approval, partial-output, and terminal-result state through `get_background_status` and `get_background_result`. A bounded result wait never cancels a running child. Steering is queued for the next completed-turn boundary rather than interrupting a provider request or tool. Stopping a child releases its reservation and preserves a durable cancelled result.

Every child write, command, MCP launch, MCP destination, OAuth browser handoff, and MCP tool call is mediated by the foreground. A child cannot consume terminal input or inherit a foreground command/MCP session grant. The CLI serializes every terminal question through one reader and opens queued child reviews even while the parent is still working; `/approvals` can also drain them manually. Child commands remain unsandboxed. MCP calls hold the project mutation window only for active execution, not while waiting for approval. Denial, cancellation while queued, stale file/config state, or a mismatched child/interaction identity executes nothing.

`/agents` lists child state. `/agent-steer CHILD_ID MESSAGE` queues guidance, `/agent-stop CHILD_ID` cancels one child, and `/new` or normal CLI exit cancels the foreground session's remaining children. Child engine sessions are hidden from the ordinary `/sessions` list. After restart, completed child results remain readable, while previously active children become interrupted with bounded partial output. Pending child approvals are abandoned, and no child, write, command, or MCP effect is replayed automatically.

## TypeScript and JavaScript intelligence

TypeScript/JavaScript language intelligence is optional and is never installed or enabled implicitly. Inspect the global installation and current project's enablement, install or refresh the managed recipe, explicitly enable or disable one canonical project, or remove the installation with:

```sh
agentlink lsp status --project /path/to/project
agentlink lsp install
agentlink lsp update
agentlink lsp enable --project /path/to/project
agentlink lsp disable --project /path/to/project
agentlink lsp remove
```

The recipe pins `typescript-language-server` 5.3.0 and TypeScript 5.9.3. AgentLink downloads the exact public npm tarballs over HTTPS, checks their pinned SHA-512 integrity, rejects install hooks and unsafe archive entries, records package tree hashes and license files, and atomically publishes the complete pair under `~/.agentlink/language-servers/typescript/`. It does not run npm, write the project's `node_modules`, or use the global npm prefix. `update` reinstalls and re-verifies the curated recipe. `remove` stops future analysis and removes the managed files; an already running chat-owned server is stopped when that host exits.

Installation and starting analysis are separate trust decisions. Installing only publishes verified files. `lsp enable` requires an interactive typed confirmation that names the canonical project's identity and warns that the server is unsandboxed; the decision is stored under that project's private CLI state. Installation alone exposes no language tools and starts no server. Once enabled, that project's coding chat starts a per-project server lazily when the agent first uses TypeScript context enrichment or one of these five read-only tools:

- `get_diagnostics`
- `get_symbols`
- `go_to_definition`
- `get_references`
- `get_hover`

Paths are project-relative and positions are 1-indexed in tool input. The server receives the canonical project root, the pinned TypeScript SDK, full document opens and changes, filesystem-change notifications, request cancellation, and bounded timeouts. AgentLink accepts only UTF-16 LSP positions, rejects unsolicited `workspace/applyEdit`, arbitrary server commands, and unsupported requests, and does not advertise rename or code actions. It retries once after a crash, bounds logs/results, and stops the child process on host exit.

Every result includes provider, server and TypeScript versions, position encoding, project coverage, document hash/version, and readiness. `unavailable`, `warming`, `stale`, and `failed` are distinct from a fresh empty diagnostic list. AgentLink re-reads a saved file before each query, so a successful AgentLink edit reaches the server as `didChange` before the next result. Definitions and references are returned only when their file locations remain inside the project and the current session's read scope. External source snippets are not disclosed.

The language server is an unsandboxed local process. Tool path checks constrain what AgentLink returns, not what the server process itself can read. `lsp disable` prevents future chats for that project from exposing or starting it, while `lsp remove` deletes the global managed installation. Declining installation or enablement, disabling or removing it, or a server crash does not disable ordinary read, edit, search, or command tools.

## Instructions and skills

At each model turn, the CLI discovers instructions and rules from three explicit roots in increasing precedence: the CLI data root's `artifacts/` directory, the project root, and the project's `.agentlink` directory. Supported instruction files are `AGENTS.md`, `AGENT.md`, and `CLAUDE.md`; rule files live under `rules/`. The current contents are resolved again for every turn rather than being trusted from an old session snapshot.

Skills under `skills/NAME/SKILL.md` and prompt commands under `commands/` are listed through `list_artifacts` and loaded through `load_artifact`. Loading requires the exact artifact ID, artifact revision, and catalog revision returned for the same turn. These tools cannot read an arbitrary path, and instruction or rule contents are activated directly rather than exposed as loadable artifacts.

## MCP

For shared `mcpServers` declarations, CLI tool calls follow the same effective per-tool policy as the VS Code agent: `toolPolicy: "allow"` and names in `allowedTools` do not request a second tool-call approval after connection consent; the default `ask` policy requires a CLI approval. Connection launch and destination approval remain separate. The legacy v1 CLI declaration and its trust rules remain a separate compatibility path.

The CLI reads global MCP configuration from `~/.agentlink/cli/mcp.json` and legacy project declarations from `.agentlink/mcp.json` under the canonical project root. `AGENTLINK_HOME` changes the global path for development or testing. The legacy files use strict JSON schema version 1. The global file contains `trustedProjectServerIds` and `servers`; a legacy project file contains `servers`. Server IDs must be unique across enabled legacy sources. A project `.agentlink/mcp.json` containing the VS Code `mcpServers` format is loaded by the shared MCP runtime. `agentlink mcp status` lists enabled shared server names as `sharedServersConfigured`; the status command reports configuration, not live connection state. Shared names, including disabled ones, shadow legacy declarations with the same name; `shadowedLegacyServerIds` lists trusted legacy entries excluded from the active configuration. The same shared MCP files are used by the extension and CLI, without a second config file.

A minimal global file is:

```json
{
  "schemaVersion": 1,
  "trustedProjectServerIds": [],
  "servers": []
}
```

A server is either:

```json
{
  "id": "local-tools",
  "transport": "stdio",
  "command": "/absolute/path/to/server",
  "args": [],
  "cwd": "/absolute/path/to/project/directory",
  "env": {
    "TOKEN": { "credential": "local-tools-token" }
  }
}
```

or:

```json
{
  "id": "remote-tools",
  "transport": "streamable-http",
  "url": "https://mcp.example.com/rpc",
  "headers": {
    "Authorization": { "credential": "remote-tools-token" }
  },
  "oauth": false
}
```

Project stdio executables and working directories must already exist inside the project root. Remote endpoints must use credential-free HTTPS. Literal secrets are not accepted in MCP configuration. Store each referenced value in macOS Keychain and inspect trust state with:

```sh
agentlink mcp credential CREDENTIAL_ID
agentlink mcp status --project /path/to/project
agentlink mcp trust SERVER_ID --project /path/to/project
```

A legacy project declaration has no discovery, launch, network, or tool-call authority until its exact server ID is added to the global trust list. The trust command displays the legacy declaration and requires typing `trust SERVER_ID`. It does not trust an entry in the shared `mcpServers` format, even when the names match. Shared server connections are admitted at runtime with explicit launch or destination approval, and shared tool calls require caller approval. Global legacy declarations are host-owned and do not need project trust, but all server activity still uses runtime approvals.

Before starting a legacy stdio server, the terminal reviews the exact executable, arguments, working directory, environment names, credential references, and operation digest. For shared `mcpServers` entries, it shows the executable, argument count, working directory, and environment names without displaying argument values, which may contain secrets. Inspect the shared config before approving the launch; the approval is bound to the full configuration and resolved launch values. Before each distinct HTTPS destination, including OAuth discovery and token endpoints, the terminal reviews the public destination without exposing URL credentials or query values. Approved launch and destination digests are cached only for the current CLI process. Public-address checks are repeated by the actual HTTP socket, redirects are rejected, and local, private, metadata, link-local, and reserved destinations are blocked before connection.

OAuth-enabled servers use a state-bound loopback callback. The CLI shows the authorization origin and opens the browser only after you type `open browser`. MCP credentials and OAuth records remain in macOS Keychain. Secret values are included in private approval binding where needed, but never in model, display, or transcript content.

Each MCP tool call is separately reviewed because MCP servers are unsandboxed and their responses are untrusted. You can allow once, allow that exact server and tool for the current chat session, or deny. Session grants are also bound to the current server configuration. Changed arguments invalidate the pending call, changed configuration invalidates both pending approvals and prior session grants, and restored approvals are revalidated before execution.

## Status, security, and limits

`agentlink status --project PATH` reports project identity, selected model, provider readiness, and session count without exposing secrets. `agentlink config show` prints non-secret CLI configuration and Keychain account names.

Before every physical provider request, including a retry, the standalone host checks a conservative input envelope against both a fixed byte ceiling and the selected model's declared input capacity. An over-limit conversation stops before network dispatch and tells you to start a fresh session. Automatic condensation is not part of this slice.

The CLI stores provider secrets, MCP credentials, and OAuth records in macOS Keychain. Local configuration, durable sessions, command rules, retained process output, child results, and project trust state remain under the AgentLink data root. Removing the npm package does not delete that data or Keychain entries. Review and remove them separately when decommissioning a machine or account.

This preview does not claim sandbox confinement, unattended operation, piped chat automation, interactive or persistent PTYs, detached or nested agents, VS Code editor-buffer conflict parity, multi-language intelligence, refactoring/code-action support, or a stable public SDK/CLI contract. Reviewed commands, background writers, stdio MCP servers, and the TypeScript language server are unsandboxed local processes and can exceed file scopes. HTTPS MCP is restricted to approved public destinations, but remote content and all language-server or MCP output remain untrusted.
