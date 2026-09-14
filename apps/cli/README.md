# AgentLink CLI

Private macOS Apple Silicon preview of AgentLink's standalone local coding host.

## Build and run from the repository

```sh
npm run cli:build
node apps/cli/dist/agentlink.js --help

# Exercise the source-build TUI in a real PTY, including colour and job control.
npm run smoke:tui --workspace @agentlink/cli
npm run smoke:tui:no-color --workspace @agentlink/cli

# Build the private tarball, verify its closure, install it outside the checkout,
# and run the installed no-colour PTY smoke.
npm run cli:smoke
```

Install, replace, or uninstall a built private tarball with:

```sh
npm install --global /path/to/agentlink-cli-0.1.0.tgz
npm install --global /path/to/new-agentlink-cli-0.1.0.tgz
npm uninstall --global @agentlink/cli
```

Installation requires public npm registry access for the exact `@napi-rs/keyring` runtime dependency and its Darwin ARM64 native package. The tarball bundles AgentLink's private JavaScript and a pinned ripgrep binary, includes generated third-party notices, and has no runtime dependency on unpublished `@agentlink/*` packages, the repository checkout, VS Code, or Electron. Removing the npm package does not delete local sessions, configuration, command rules, or macOS Keychain credentials.

A coding session requires an interactive terminal. Status, session listing, provider configuration, and help commands can run without one.

Interactive chat starts as a compact AgentLink-branded composer, then expands into an Ink terminal application with a persistent Markdown transcript and multiline composer after the first submission or live session activity:

- `Enter` sends. `Ctrl+J`, `Shift+Enter`, `Alt+Enter`, or supported `Ctrl+Enter` inserts a newline.
- `Tab` and `Shift+Tab` move between the composer, transcript, and bounded activity shelf. Arrow keys, Page Up/Down, Home, and End scroll the focused transcript. Tool calls are collapsed by default; press `Enter` while the transcript is focused to expand or collapse the newest visible tool group. In the activity shelf, Up/Down/Home/End select a section and Enter or Space expands its details. `Ctrl+T` jumps directly to the expanded TODO list.
- Press `Ctrl+O` for the control centre. It provides keyboard-only access to approvals, retained processes, background agents, sessions, model and reasoning selectors, mode/write-policy status, and shortcut help.
- Type `/` for command completion. Selecting an action command such as `/model`, `/reasoning`, or `/help` runs it immediately. The model selector uses AgentLink's maintained provider catalogue and shows each model's supported reasoning levels.
- Type `@` to select up to four project-file attachments, or paste one project file path. Text files are safely inlined, images and PDFs are sent as model media, and attachments appear in the transcript. Supported terminals render image previews, with a textual filename fallback elsewhere.
- `Ctrl+C` cancels an active turn or approval and exits while idle. `Ctrl+Z` suspends AgentLink through the shell's normal job-control flow; `fg` resumes it with a full redraw.

The activity shelf appears only when relevant and shows provider token usage, active turn and tool work, the current session TODO, queued foreground messages, noteworthy retained commands, active structured questions, pending approvals, and background agents. The transcript also shows animated working, thinking, and collapsed tool-group states while preserving every `You` and `AgentLink` message label. Expanded tool groups reveal bounded input and result details; collapsed groups never print their JSON. Markdown headings, emphasis, inline code, fenced code, lists, blockquotes, links, and tables render as terminal UI rather than source syntax. Blank lines separate Markdown blocks, two trailing spaces or a backslash preserve an explicit line break, and an ordinary newline inside a paragraph remains a soft break. Table columns share the available width equally and truncate long cells in narrow terminals.

File diffs, command launches and rules, MCP operations, background approvals, and structured questions open inside the TUI. Use Up/Down to choose an action, Page Up/Down to inspect long details, Enter to confirm, and Escape to cancel when the panel allows cancellation. Background commands still require typing `allow background`; selector choices do not weaken existing stale-proposal, protected-path, or session-grant checks.

The TUI uses the alternate screen and restores terminal input, cursor, paste, and screen modes on normal exit, render failure, Ctrl+C, and Ctrl+Z suspend/resume. An outstanding review or question is cancelled if the TUI closes rather than leaving terminal work unresolved. `NO_COLOR=1` disables colour while preserving layout and controls.

Terminal limitations: the preview requires an interactive TTY with standard ANSI alternate-screen, cursor, and bracketed-paste support. Very narrow or short windows intentionally truncate detail rows to keep the composer usable. Full-width and combining Unicode rely on the terminal's width reporting, so unusual font/terminal combinations may align differently. Transcript selection and copying use the terminal emulator; there is no mouse-only UI, embedded shell, PTY attachment, inline image/PDF rendering, or Windows/Linux terminal support yet.

The current preview provides multi-turn chat, provider setup, durable local sessions, project-relative read/list/search/context tools, reviewed single-file writes and patches, reviewed commands, MCP, scoped background writers, and optional managed TypeScript/JavaScript intelligence. Every ungranted write shows the complete diff and baseline/proposed SHA-256 hashes. Approval can apply once, continue the same tool on that unprotected path along the verified content-hash chain for the current session, or deny with no write. External edits, changed scopes, switching between patch and replacement, and path aliases require a fresh review. Successful writes report verified exact durability, and protected instruction or authority files always require a fresh human approval.

Install optional TypeScript/JavaScript support explicitly:

```sh
agentlink lsp status --project /path/to/project
agentlink lsp install
agentlink lsp update
agentlink lsp enable --project /path/to/project
agentlink lsp disable --project /path/to/project
agentlink lsp remove
```

The managed recipe pins `typescript-language-server` 5.3.0 and TypeScript 5.9.3 with exact SHA-512 integrity. Installation and starting analysis are separate trust decisions: installation only downloads, verifies, and atomically publishes files under `~/.agentlink/language-servers/`; `lsp enable` then requires an interactive typed confirmation for each canonical project. Only an enabled project's coding chat can lazily start the server when it uses diagnostics, symbols, definition, references, hover, or TypeScript context enrichment. The server is an unsandboxed local process and can read beyond tool scopes, although AgentLink only returns currently scoped project results. Unavailable, warming, stale, and failed analysis stays explicit and never appears as zero diagnostics.

Only one CLI writer may own a canonical project root or overlapping root at a time. This coordinates participating CLI processes, not other editors. Conflicts are detected against saved files; unsaved editor buffers are invisible.
