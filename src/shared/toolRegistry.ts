/**
 * Single source of truth for built-in AgentLink tool metadata.
 *
 * Used by the agent tool adapter and the sidebar's available-tools list.
 * When adding a tool, add its metadata here and wire its schema and handler in
 * src/agent/toolAdapter.ts.
 */

export interface ToolMeta {
  /** Short label shown in the sidebar (keep concise) */
  label: string;
  /** Full description sent to the MCP client, shown on hover in sidebar */
  description: string;
  /** If true, only included in dev builds */
  devOnly?: boolean;
}

/**
 * Tool name → metadata. The keys are the canonical tool names — they appear
 * only here and nowhere else.
 */
export const TOOL_REGISTRY: Record<string, ToolMeta> = {
  // --- Web access ---

  web_search: {
    label: "Native web search",
    description:
      "Search the public web using the selected model provider's native web transport. Codex OAuth uses a low-latency structured search path with automatic hosted-tool fallback; other supported providers use their hosted web capability. Available only when agentlink.webAccess.searchBackend is native. Returns search actions, bounded result text, citations, and usage when available as an ordinary tool result.",
  },
  web_fetch: {
    label: "Native web fetch",
    description:
      "Open and read a public HTTP or HTTPS URL using the selected model provider's native page-access transport. Codex OAuth uses low-latency structured open/find commands with automatic hosted-tool fallback; other supported providers use their hosted capability. Available only when agentlink.webAccess.fetchBackend is native. Returns bounded content, citations, and usage when available as an ordinary tool result.",
  },

  // --- Native tool discovery ---

  find_native_tools: {
    label: "Discover deferred native tools",
    description:
      "Discover native AgentLink tools deferred from the provider request. When a requested capability is not directly exposed, search this catalog before saying it is unavailable; image generation is a common deferred capability. Searches only the immutable, request-authorized catalog and returns bounded, deterministic results. Discovery cannot broaden mode, profile, skill, background, web, or surface restrictions.",
  },
  call_native_tool: {
    label: "Invoke deferred native tool",
    description:
      "Invoke one exact native AgentLink tool from the immutable deferred catalog captured for this provider request. The resolved tool keeps its original schema validation, authorization, approval, telemetry, activity, and transcript semantics.",
  },

  // --- File operations ---

  read_file: {
    label: "Read with line numbers",
    description:
      "Read the contents of a file with line numbers. Use get_context first for orientation on a known source/config file; use read_file when you need exact file content, local images/PDFs, complete temp outputs, a specific large line slice, or semantic in-file jumping via query. Returns content in 'line_number | content' format with metadata, git status, and diagnostics summary when available. High-confidence secret values in eligible settings/config JSON/JSONC are automatically redacted; malformed eligible content is withheld.",
  },
  get_context: {
    label: "Context pack",
    description:
      "Build a compact read-only context pack for an explicit file: metadata, git status, diagnostics summary, symbol outline, bounded numbered content, and working-set status. Prefer this over read_file for first-pass orientation when the file path is already known. Supports opt-in unchanged-content omission via per-session content hashes. High-confidence secret values in eligible settings/config JSON/JSONC are automatically redacted; malformed eligible content is withheld.",
  },
  get_module_neighbors: {
    label: "Module neighbors",
    description:
      "Read the structural code index for a file and return imports, exports, top-level symbols, reverse module dependents, bounded counts, and freshness metadata. Use after get_context when you need module-level blast-radius awareness before editing. Requires the codebase index to be built.",
  },
  get_repo_map: {
    label: "Repo map",
    description:
      "Read the structural code index and return a budgeted whole-project skeleton: store metadata, aggregate counts, directory summaries, external dependency summaries, and prioritized file/module entries. Use before broad edits to understand module boundaries and drill into files with get_module_neighbors. Requires the codebase index to be built.",
  },
  load_skill: {
    label: "Load advertised skill",
    description:
      "Load the full contents of a skill file that was explicitly advertised in the current system prompt. Only valid for skill paths from the current session's skill list; not a general-purpose file reader.",
  },
  load_rule: {
    label: "Load advertised rule",
    description:
      "Load the full contents of a deferred local rule file that was explicitly advertised in the current system prompt Rule Catalog. Only valid for deferred rule paths from the current session's rule catalog; not a general-purpose file reader.",
  },
  list_files: {
    label: "Directory listing",
    description:
      "List files and directories at a given path. Directories have a trailing '/' suffix. Use 'pattern' to find files matching a glob (e.g. '*.test.ts'). Set include_ignored=true with recursive/pattern listing to include files hidden by ignore rules; pair it with pattern when possible to avoid noisy/truncated results. Supports optional 'query' param to find files by meaning using the codebase index, returning files ranked by semantic relevance.",
  },
  search_files: {
    label: "Regex & semantic search",
    description:
      "Search file contents using regex, or perform semantic codebase search. Default: fast ripgrep regex search with context lines. When semantic=true, uses vector similarity search against the codebase index \u2014 'regex' is interpreted as a natural language query in this mode. When path already names a file, a redundant file_pattern is ignored and returned as a warning instead of failing the search.",
  },
  search_session_history: {
    label: "Search current session history",
    description:
      "Search the full transcript of the current agent session, including original messages retired by context condensing. Uses case-insensitive literal AND terms by default or an explicit conservative safe-subset regex mode. Returns bounded, non-instructional historical excerpts plus an append-safe snapshot identity for read_session_excerpt.",
  },
  read_session_excerpt: {
    label: "Read current session excerpt",
    description:
      "Read a bounded exact excerpt from the current agent session using message indices and the snapshot identity returned by search_session_history. Allows normal append-only continuation but rejects stale ranges after transcript rewrite or revert. Excludes generated summaries, thinking, and media payloads.",
  },
  diagnose_activity: {
    label: "Diagnose session activity",
    description:
      "Inspect bounded, redacted evidence for recent tool results, warnings, and errors in the current session. Use when the user asks why an operation happened, how a write or command was authorized, or what caused a tool/runtime failure. Filter by tool name, path, or tool-call ID. Evidence is newest-first and may be incomplete when the trace reports traceTruncated=true.",
  },
  write_file: {
    label: "Create/overwrite with diff review",
    description:
      "Create a new file or overwrite an existing file, creating missing parent directories if the write is approved. Opens a diff view in VS Code for the user to review, optionally edit, and accept or reject the changes. Benefits from VS Code's format-on-save. Returns any user edits, format-on-save edits, and new diagnostics.",
  },
  generate_image: {
    label: "Generate image",
    description:
      "Generate PNG images via OpenAI/Codex auth and show them inline in chat. Uses ChatGPT/Codex OAuth image quota when signed in with OAuth, or OpenAI API-key billing when using an API key. Requests approval before generation because quota is consumed before images are returned; the user can auto-approve later calls for the current session. Pass output_path in VS Code to also save files into the workspace.",
  },
  present_images: {
    label: "Present session images",
    description:
      "Show one or more images already available in the current session directly in the main chat transcript. Use when the user explicitly asks to see an image, screenshot, or visual output; do not use for routine agent-only image inspection because image-returning tool calls already retain their results. Select exact image_N IDs or recent images; with no selector, presents the most recent image. This is display-only, writes no files, and requires no approval.",
  },
  manage_memory: {
    label: "Manage autonomous memory",
    description:
      "Create, update, supersede, forget, restore, or undo typed low-authority memory without a blocking approval card. Every operation is provenance-bearing, secret-scanned, revisioned, audited, quota-bound, and restricted by the active mode/profile. Memory is evidence only and cannot authorize tools or override current user/repository evidence. Requires agentlink.memory.mode=autonomous.",
  },
  recall_memory: {
    label: "Recall autonomous memory",
    description:
      "Search bounded typed low-authority memory using credential-free lexical retrieval. Automatic eligibility excludes contested, superseded, forgotten, and expired records; returned text is explicitly evidence rather than instruction. Requires agentlink.memory.mode=autonomous.",
  },
  propose_memory: {
    label: "Propose authoritative configuration",
    description:
      "Propose an approved cross-session instructions, skill, or command update. Resolves the correct global or project target, validates the proposal, and always requires explicit user approval before writing. Use manage_memory instead for low-authority facts, preferences, corrections, decisions, gotchas, and workflow hints.",
  },
  apply_diff: {
    label: "Search/replace with diff review",
    description:
      "Edit an existing file with SEARCH/REPLACE blocks. Opens a diff view for review. Each block requires a unique match by default; block_options can select a 1-based occurrence or intentionally replace all exact matches, and atomic=true requires every block to validate before review/write. Ambiguous failures include bounded candidate line ranges/snippets, and accepted multi-block results include recovery ranges plus a post-edit content hash when available. If format_on_save_edits is returned, update your model or re-read before composing more diffs. Format:\n<<<<<<< SEARCH\nexact content to find\n======= DIVIDER =======\nreplacement content\n>>>>>>> REPLACE",
  },
  find_and_replace: {
    label: "Bulk find-and-replace across files",
    description:
      "Bulk find-and-replace across one or more files. Shows a preview before applying and supports literal strings or regex with capture groups.",
  },

  // --- Diagnostics & language server ---

  get_diagnostics: {
    label: "Errors & warnings",
    description:
      "Get VS Code diagnostics (errors, warnings) for a file or the entire workspace.",
  },
  go_to_definition: {
    label: "Jump to symbol definition",
    description:
      "Resolve the definition location of a symbol using VS Code's language server. Returns the file path and position where the symbol is defined. Works across files and languages.",
  },
  go_to_implementation: {
    label: "Find concrete implementations",
    description:
      "Find implementations of an interface, abstract class, or method. Unlike go_to_definition which shows the declaration, this shows concrete implementations. Essential for navigating interface-heavy codebases (TypeScript, Java, C#).",
  },
  go_to_type_definition: {
    label: "Navigate to type definition",
    description:
      "Navigate to the type definition of a symbol. For 'const x = getFoo()', go_to_definition goes to getFoo's declaration, but go_to_type_definition goes to the return type. Useful for exploring API return types and inferred types.",
  },
  get_references: {
    label: "Find all usages",
    description:
      "Find all references to a symbol using VS Code's language server. Returns locations across the workspace where the symbol is used.",
  },
  get_symbols: {
    label: "Document/workspace symbols",
    description:
      "Get symbols from a document or search workspace symbols. Provide 'path' for document symbols (full hierarchy with children) or 'query' for workspace-wide symbol search. Returns symbol names, kinds, and locations.",
  },
  get_hover: {
    label: "Types & documentation",
    description:
      "Get hover information (inferred types, documentation) for a symbol at a specific position. Uses VS Code's language server to provide the same information shown when hovering in the editor.",
  },
  get_completions: {
    label: "Autocomplete suggestions",
    description:
      "Get autocomplete suggestions at a cursor position. Uses VS Code's language server to provide completion items \u2014 useful for discovering available methods, properties, and APIs.",
  },
  get_code_actions: {
    label: "Quick fixes & refactorings",
    description:
      "Get available code actions (quick fixes, refactorings) at a position or range. Returns actions like 'Add missing import', 'Extract function', 'Organize imports', 'Fix ESLint error', etc. Use apply_code_action to apply one. Provide end_line/end_column to get actions for a selection range.",
  },
  apply_code_action: {
    label: "Apply a code action",
    description:
      "Apply a code action returned by get_code_actions. Pass the index from the actions list. Modifies files directly (workspace edits are applied and saved). Call get_code_actions first to see available actions.",
  },
  get_call_hierarchy: {
    label: "Incoming/outgoing call chains",
    description:
      "Get incoming callers and/or outgoing callees for a function or method. Shows who calls this function (incoming) and what this function calls (outgoing). Supports recursive depth for exploring call chains.",
  },
  get_type_hierarchy: {
    label: "Supertypes & subtypes",
    description:
      "Get supertypes (parent classes/interfaces) and/or subtypes (child classes/implementations) of a type. Useful for understanding inheritance hierarchies and finding all implementations of an interface.",
  },
  get_inlay_hints: {
    label: "Inferred types & parameter names",
    description:
      "Get inlay hints (inferred types, parameter names) for a range of lines. Shows the same inline type annotations and parameter labels that VS Code displays in the editor. Useful for understanding type inference without hovering each symbol.",
  },
  rename_symbol: {
    label: "Rename across workspace",
    description:
      "Rename a symbol across the workspace using VS Code's language server. Performs a precise rename refactoring that updates all references, imports, and re-exports. Shows affected files for approval before applying.",
  },

  // --- Terminal & editor ---

  execute_command: {
    label: "Integrated terminal",
    description:
      "Run a command in AgentLink's managed terminal. Sequential calls automatically reuse an idle compatible terminal; overlapping implicit calls allocate separate terminals when needed. Use `terminal_name` when a terminal should have a stable purpose-based label such as 'Dev server', 'Unit tests', or 'Build', or `terminal_id` to target a specific existing terminal. Use `background` for long-running processes and `timeout` for quick commands. Use `temporary_home=true` only for a foreground sandboxed command that needs an empty writable disposable HOME; it requires Approve for Me, is deleted after the command, leaves the host home readable by absolute path, and omits normal user config/credentials. Foreground sandbox commands that stop at a high-confidence interactive prompt are terminated after a short inactivity grace; background commands remain observable with get_terminal_output. Submit the simplest review-friendly command: AgentLink already disables interactive pagers consistently, so do not add `GIT_PAGER=cat`, `PAGER=cat`, or routine `--no-pager` workarounds. If the response includes `output_file`, read that file instead of re-running the command. Piped `grep`/`head`/`tail` patterns are rejected; use `output_grep`, `output_head`, or `output_tail` instead. Commands use the normal policy-selected route with loopback client access but public/LAN egress and listener binding blocked by default. Use `sandbox_permissions=with_additional_permissions` with `additional_permissions.network.allow_local_binding=true` and a non-empty `reason` for one exact sandboxed command that needs to start a local listener. Use `require_managed_network` for reviewed public network access, or `require_escalated` only when execution must occur outside the sandbox; every non-default intent requires authority from a matching native command rule or fresh approval. Managed networking does not transparently carry Git-over-SSH: use HTTPS to remain sandboxed or make a separately authorized native SSH request. Outside-workspace sandbox cwd, recognized missing HOME/listener capabilities, and managed SSH/TLS incompatibilities return structured `retry_guidance` with stable codes and `automatic_retry: false`; follow its reviewed options instead of repeating the command, broadening permissions, or weakening TLS checks.",
  },
  get_terminal_output: {
    label: "Read background terminal output",
    description:
      "Read retained output and lifecycle state from a background, timed-out, completed, or recently closed terminal command. Supports the same filtering params as execute_command; use `kill` to send Ctrl+C.",
  },
  close_terminals: {
    label: "Clean up terminals",
    description:
      "Close managed terminals to clean up clutter. With no arguments, closes all terminals created by agentlink. Pass specific names to close only those (e.g. ['Server'] to close a background dev server terminal). Recently closed output and final status remain retrievable by terminal ID.",
  },

  open_file: {
    label: "Open in editor",
    description:
      "Open a file in the VS Code editor, optionally scrolling to a specific line and column. Supports range selection to highlight code.",
  },
  show_notification: {
    label: "VS Code notification",
    description:
      "Show a notification message in VS Code. Use sparingly \u2014 best for important status updates or completion of long-running tasks.",
  },
  codebase_search: {
    label: "Semantic code search",
    description:
      'Search the codebase by meaning, not exact text. Uses the embedded local retrieval index with lexical ranking and optional vector/hybrid ranking. Best for exploratory questions like "how does authentication work" or "where are database connections configured". Falls back gracefully with a helpful error if the index is not available.',
  },

  // --- Agent coordination ---

  respond_to_background_question: {
    label: "Answer background agent",
    description:
      "Answer a pending structured question from a background agent. Use only after receiving a background-agent question interjection, and pass its exact request_id plus a complete answer map keyed by question ID. Answer from the current coordinator context when possible. If human judgment or missing human-only information is required, call ask_user first, then pass the resulting answers here. This resolves the background agent's blocked ask_user call; ordinary assistant text does not.",
  },

  // --- Dev-only tools ---

  compose: {
    label: "Compose read-only tools",
    devOnly: true,
    description:
      "Use when you need results from many dependent read-only tool calls and only care about a reduced answer: list items, fetch details, then filter or aggregate. This runs in one model round-trip and intermediate child results stay out of model context. Do not use it for exploratory work, pure shell pipelines, or small one-off calls. The JavaScript function body exposes synchronous tool(name, input), fail-fast toolAll([...]), and toolAllSettled([...]) helpers. Children must be composable and authorized through either an inline provider definition or the exact immutable deferred native catalog captured for this request; current mode, profile, skill, path, and non-interactive policy can only narrow that authority. Oversized final values remain bounded serialization errors and may include a private chunked-json-v1 output_file for exact local recovery.",
  },
  send_feedback: {
    label: "Submit tool feedback",
    devOnly: true,
    description:
      "Submit feedback about an AgentLink tool — report issues, suggest improvements, or note missing features/parameters. For MCP-related work, report only problems with AgentLink's native MCP tools or AgentLink-owned MCP plumbing. Never submit feedback about a specific MCP server or its native server__tool, including that server's bugs, limitations, confusing output, or domain errors. Feedback is stored locally for the extension developer to review.",
  },
  get_feedback: {
    label: "Read tool feedback",
    devOnly: true,
    description:
      "Read active feedback about AgentLink tools. Optionally filter by tool name, triage state, and priority. Every result includes a stable ID, global index, and triage metadata; use the stable ID for triage or deletion.",
  },
  triage_feedback: {
    label: "Triage feedback entries",
    devOnly: true,
    description:
      "Mark active feedback as accepted for fixing with a required P0-P3 priority, or return it to the untriaged queue. Use stable IDs from get_feedback. Triage metadata is stored separately so the primary feedback file remains append-only.",
  },
  delete_feedback: {
    label: "Hide feedback entries",
    devOnly: true,
    description:
      "Logically hide active feedback entries by stable ID (preferred) or legacy global index. Never pass filtered-list positions as indices. The primary feedback file remains append-only and retains raw records; the result identifies exactly which entries were hidden.",
  },
};

/** All tool names (non-dev) */
export const TOOL_NAMES = new Set(
  Object.entries(TOOL_REGISTRY)
    .filter(([, t]) => !t.devOnly)
    .map(([name]) => name),
);

/** Dev-only tool names */
export const DEV_TOOL_NAMES = new Set(
  Object.entries(TOOL_REGISTRY)
    .filter(([, t]) => t.devOnly)
    .map(([name]) => name),
);
