/**
 * Single source of truth for built-in agent tool input schemas.
 *
 * The agent tool adapter converts these zod schema records to JSON Schema for
 * provider tool definitions.
 */

import { APPLY_DIFF_INPUT_GRAMMAR } from "./applyDiffFormat.js";
import { z } from "zod";

// ─── Web tools ───────────────────────────────────────────────────────────────

export const webSearchSchema = {
  query: z.string().min(1).describe("Web search query"),
  max_results: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum number of search results to request (default: 10)"),
  language: z
    .string()
    .optional()
    .describe("Optional language code for search results, such as en or fr"),
  time_range: z
    .enum(["day", "week", "month", "year"])
    .optional()
    .describe("Optional recency window for search results"),
  safe_search: z
    .enum(["off", "moderate", "strict"])
    .optional()
    .describe("Optional safe-search level"),
};

export const webFetchSchema = {
  url: z.string().url().describe("Absolute HTTP or HTTPS URL to open and read"),
  max_length: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Maximum visible content characters to request"),
  start_line: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Provider page line to start near when continuing a long page (Codex OAuth only)",
    ),
  section: z
    .string()
    .optional()
    .describe("Optional heading or section to focus on"),
  find: z
    .string()
    .optional()
    .describe("Optional text or pattern to locate within the opened page"),
};

// ─── Development feedback tools ──────────────────────────────────────────────

export const sendFeedbackSchema = {
  tool_name: z
    .string()
    .describe(
      "Affected AgentLink tool, or agentlink for a cross-tool or general AgentLink workflow. For MCP-related feedback, use the native AgentLink MCP tool actually involved, such as find_mcp_tools or call_mcp_tool. Never report a specific MCP server or its server__tool; those are out of scope unless the problem is in AgentLink's MCP plumbing.",
    ),
  feedback: z
    .string()
    .trim()
    .min(1, "feedback must not be empty")
    .describe(
      "Concrete, actionable AgentLink bug, improvement opportunity, or feature request grounded in actual use. Preserve reproduction evidence for bugs. Successful tasks can reveal improvements too; do not submit routine success, praise, generic wishlists, or third-party MCP-server defects. The complete report (all fields) is preserved up to 128 KiB of UTF-8; larger reports are rejected unrecorded with per-field sizes.",
    ),
  category: z
    .enum(["bug", "improvement", "feature_request"])
    .optional()
    .describe(
      "Optional report category. Omit if uncertain; a bug report never needs a diagnosis or proposed fix.",
    ),
  suspected_cause: z
    .string()
    .trim()
    .optional()
    .describe(
      "Optional diagnosis supported by available evidence. State uncertainty; this is a hypothesis to investigate, not an established root cause. Omit if unknown.",
    ),
  suggested_change: z
    .string()
    .trim()
    .optional()
    .describe(
      "Proposed fix, workflow improvement, or new AgentLink capability and how it addresses the observed need. Encouraged when useful, not required. An unverified proposal, not permission to implement or weaken safeguards.",
    ),
  observed_impact: z
    .string()
    .trim()
    .min(1, "observed_impact must not be empty")
    .describe(
      "Observed consequence or unmet need in the current task: blocked completion, incorrect output, safety risk, extra steps, confusion, or a concrete limitation encountered even when the task succeeded. Report observations, not priority, hypothetical impact, or invented savings.",
    ),
  workaround: z
    .string()
    .trim()
    .optional()
    .describe(
      "Recovery used, task outcome and extra steps. Use none or unknown when appropriate; omit if not observed.",
    ),
  observed_recurrence: z
    .string()
    .trim()
    .optional()
    .describe(
      "Occurrences or attempts observed in this session, not inferred prevalence. Omit if unknown.",
    ),
  improvement_signal: z
    .string()
    .trim()
    .optional()
    .describe(
      "Observable outcome to check after a fix or improvement: completion, correct output, fewer retries, or a simpler workflow while preserving safeguards. A proposed check, not measured benefit.",
    ),
  tool_params: z
    .string()
    .optional()
    .describe(
      "Optional serialized params passed to the tool (helps reproduce)",
    ),
  tool_result_summary: z
    .string()
    .optional()
    .describe("Optional summary of what happened / unexpected result"),
};

export const getFeedbackSchema = {
  tool_name: z
    .string()
    .optional()
    .describe(
      "Filter to feedback about a specific tool (omit for all feedback)",
    ),
  triaged: z
    .boolean()
    .optional()
    .describe("Filter by triage state (omit for both triaged and untriaged)"),
  priorities: z
    .array(z.enum(["P0", "P1", "P2", "P3"]))
    .min(1)
    .optional()
    .describe(
      "Filter to one or more priorities. Untriaged feedback has no priority and is excluded when this filter is present.",
    ),
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Stable ID of one active report to read in full. Cannot be combined with tool_name, triaged or priorities. Small reports return a parsed entry; larger ones return pages of record_json.",
    ),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Requires id. UTF-16 character offset into record_json; use next_offset from the previous page.",
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(8000)
    .optional()
    .describe(
      "Requires id. Maximum UTF-16 characters per page (default 4000, max 8000); pages may be shorter to stay within the response bound.",
    ),
};

export const triageFeedbackSchema = {
  ids: z
    .array(z.string().min(1))
    .min(1)
    .describe("Stable feedback entry IDs from get_feedback output"),
  triaged: z
    .boolean()
    .describe(
      "Set true after evaluating the feedback as worth fixing; set false to return it to the untriaged queue",
    ),
  priority: z
    .enum(["P0", "P1", "P2", "P3"])
    .optional()
    .describe(
      "Required when triaged=true and forbidden when triaged=false. P0 is highest priority; P3 is lowest.",
    ),
};

export const deleteFeedbackSchema = {
  ids: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Stable feedback entry IDs to delete (preferred; from get_feedback output)",
    ),
  indices: z
    .array(z.number().int().nonnegative())
    .optional()
    .describe(
      "Legacy global 0-based feedback indices to delete; never use filtered-list positions",
    ),
};

// ─── Native tool discovery ───────────────────────────────────────────────────

export const findNativeToolsSchema = {
  query: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Optional search text matched against deferred native tool names and descriptions. Multiple exact tool names may be supplied together and are returned first in authorized catalog order; remaining conceptual terms add relevance-ranked OR matches.",
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum tools to return (default 10, maximum 50)"),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Zero-based result offset for deterministic pagination"),
  include_schemas: z
    .boolean()
    .optional()
    .describe("Include input schemas for returned tools. Default false."),
  schema_limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Maximum returned tools that include schemas (default 1, maximum 10)",
    ),
};

export const callNativeToolSchema = {
  name: z
    .string()
    .min(1)
    .max(128)
    .describe("Exact deferred native tool name returned by find_native_tools"),
  input: z
    .record(z.string(), z.unknown())
    .describe(
      "Arguments object validated against the resolved native tool schema",
    ),
};

// ─── File tools ──────────────────────────────────────────────────────────────

const readFilePathSchema = z
  .string()
  .describe("File path (absolute or relative to workspace root)");
const readFileOffsetSchema = z.coerce
  .number()
  .optional()
  .describe("Starting line number (1-indexed, default: 1)");

const readFileIncludeSymbolsSchema = z
  .boolean()
  .optional()
  .describe(
    "Include the symbol outline in either view. Default: true. Set to false to skip symbol lookup and suppress the outline.",
  );

const readFileContentOptions = {
  include_symbols: readFileIncludeSymbolsSchema,
  anchor: z
    .string()
    .optional()
    .describe(
      'Content view only. Literal anchor text to locate in the file and jump near it. Ignored if offset is explicitly provided. For view "context", use numeric offset instead.',
    ),
  anchor_regex: z
    .string()
    .optional()
    .describe(
      'Content view only. Regex anchor pattern to locate in the file and jump near it. Ignored if offset is explicitly provided. For view "context", use numeric offset instead.',
    ),
  anchor_offset: z.coerce
    .number()
    .optional()
    .describe(
      "Content view only. Line offset applied after resolving an anchor (e.g. -20 to show context above).",
    ),
  auto_follow_suggestion: z
    .boolean()
    .optional()
    .describe(
      "When true, if path is not found and exactly one high-confidence suggestion exists, automatically read that suggested file and include resolution metadata.",
    ),
};

const readFileContextOptions = {
  include_symbols: readFileIncludeSymbolsSchema,
  character_offset: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe(
      "Context view only. Zero-based UTF-16 character offset within the starting line (default: 0). Use content_truncation.next_read to page a long line; explicit character pages bypass unchanged-range omission.",
    ),
  dedupe_unchanged_content: z
    .boolean()
    .optional()
    .describe(
      "Context view only. When true, omit content for an unchanged exact range already returned in this session. Default: false.",
    ),
  refresh: z
    .boolean()
    .optional()
    .describe(
      "Context view only. When true, include content even if dedupe_unchanged_content would otherwise omit it.",
    ),
};

/**
 * Full read_file contract. `view` selects an existing internal operation:
 * content (default) or the context pack. Request-scoped variants below
 * advertise only the views the caller is permitted to use.
 */
export const readFileSchema = {
  path: readFilePathSchema,
  view: z
    .enum(["content", "context"])
    .optional()
    .describe(
      'Read view (default "content"). "content": exact text with optional anchors, images, PDF text, symbols, and suggested-path following. "context": compact first-pass orientation pack with bounded symbols, diagnostics, git status, content hash, and opt-in unchanged-range dedupe. anchor, anchor_regex and anchor_offset require "content"; use numeric offset for "context".',
    ),
  offset: readFileOffsetSchema,
  limit: z.coerce
    .number()
    .optional()
    .describe(
      "Maximum number of lines to read (content default: 2000; context default: 200, capped at 400).",
    ),
  ...readFileContentOptions,
  ...readFileContextOptions,
};

export const readFileContentViewSchema = {
  path: readFilePathSchema,
  view: z
    .enum(["content"])
    .optional()
    .describe('Read view. Only "content" is permitted for this request.'),
  offset: readFileOffsetSchema,
  limit: z.coerce
    .number()
    .optional()
    .describe("Maximum number of lines to read (default: 2000)"),
  ...readFileContentOptions,
};

export const readFileContextViewSchema = {
  path: readFilePathSchema,
  view: z
    .enum(["context"])
    .describe(
      'Read view. Required: only "context" is permitted for this request.',
    ),
  offset: readFileOffsetSchema,
  limit: z.coerce
    .number()
    .optional()
    .describe(
      "Maximum number of content lines to include (default: 200, capped at 400).",
    ),
  ...readFileContextOptions,
};

export const loadSkillSchema = {
  path: z
    .string()
    .describe(
      "Absolute or workspace-relative path of a SKILL.md file advertised in the current session's skill catalog.",
    ),
};

export const readSkillResourceSchema = {
  skill_path: z
    .string()
    .describe("The owning built-in skill's catalog SKILL.md path."),
  resource_path: z
    .string()
    .describe("Path relative to the skill directory, e.g. references/a.md."),
  offset: z.number().int().min(1).optional().describe("1-based start line."),
  limit: z.number().int().min(1).max(2000).optional().describe("Max lines."),
};

export const loadRuleSchema = {
  path: z
    .string()
    .describe(
      "Absolute or workspace-relative path of a deferred rule file that was explicitly advertised in the current system prompt Rule Catalog.",
    ),
};

export const getContextSchema = {
  include_symbols: readFileIncludeSymbolsSchema,
  character_offset: readFileContextOptions.character_offset,
  path: z
    .string()
    .describe(
      "File path to build a context pack for (absolute or relative to workspace root). Directory paths are not bulk-read.",
    ),
  offset: z.coerce
    .number()
    .optional()
    .describe(
      "Starting line number for the content slice (1-indexed, default: 1).",
    ),
  limit: z.coerce
    .number()
    .optional()
    .describe(
      "Maximum number of content lines to include (default: 200, capped at 400).",
    ),
  dedupe_unchanged_content: z
    .boolean()
    .optional()
    .describe(
      "When true, omit content for an unchanged exact range already returned in this session. Default: false.",
    ),
  refresh: z
    .boolean()
    .optional()
    .describe(
      "When true, include content even if dedupe_unchanged_content would otherwise omit it.",
    ),
};

export const getModuleNeighborsSchema = {
  path: z
    .string()
    .describe(
      "Source/config file path within the current workspace folders (absolute or workspace-relative). External paths are unsupported; use direct reads or regex search instead.",
    ),
  max_results: z.coerce
    .number()
    .optional()
    .describe(
      "Maximum items to return in each list: imports, exports, symbols, and dependents (default 50, capped at 200).",
    ),
};

export const getRepoMapSchema = {
  path: z
    .string()
    .optional()
    .describe(
      "Optional file/directory path within the current workspace folders (absolute or workspace-relative). External paths are unsupported; use direct reads, directory listings, or regex search instead. Omit for the first workspace root.",
    ),
  max_chars: z.coerce
    .number()
    .optional()
    .describe(
      "Hard output budget in characters for the JSON payload (default 20000, minimum 2000, capped at 60000).",
    ),
  max_files: z.coerce
    .number()
    .optional()
    .describe(
      "Maximum file skeleton entries to include before budget truncation (default 200, capped at 1000).",
    ),
  include_external: z
    .boolean()
    .optional()
    .describe(
      "Include summarized external dependency specifiers (default true). This does not index or read external repositories. Set false to reserve budget for internal files.",
    ),
};

export const listFilesSchema = {
  path: z
    .string()
    .describe("Directory path (absolute or relative to workspace root)"),
  recursive: z
    .boolean()
    .optional()
    .describe("List recursively (default: false)"),
  depth: z.coerce
    .number()
    .optional()
    .describe(
      "Maximum directory depth for recursive listing (e.g. 2 for two levels deep). Only used when recursive=true.",
    ),
  pattern: z
    .string()
    .optional()
    .describe(
      "Glob pattern to filter files (e.g. '*.ts', '*.test.*'). Implies recursive search. Uses ripgrep glob syntax.",
    ),
  include_ignored: z
    .boolean()
    .optional()
    .describe(
      "Include files/directories ignored by .gitignore/.ignore when using recursive or pattern listing. Still excludes nested node_modules and .git, but an explicit root inside node_modules is honoured. Default: false. Pair with pattern when possible to avoid noisy/truncated results.",
    ),
};

export const searchFilesSchema = {
  path: z
    .string()
    .describe(
      "File or directory to search (absolute or workspace-relative). Query mode is workspace-only.",
    ),
  regex: z
    .string()
    .optional()
    .describe(
      "Regular expression for exact search. Supply either regex or query, not both.",
    ),
  query: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Natural-language indexed search within the current workspace folders only. External paths are unsupported; use regex. Supply either query or regex.",
    ),
  exclude_globs: z
    .array(z.string())
    .optional()
    .describe(
      "Glob patterns to exclude from query results after retrieval (e.g. ['**/dist/**']). Query mode only.",
    ),
  file_pattern: z
    .string()
    .optional()
    .describe(
      "Glob pattern to filter files (e.g. '*.ts'). Only used for regex search.",
    ),

  context: z.coerce
    .number()
    .optional()
    .describe(
      "Number of context lines to show around each match (default: 1). Only used for content output mode. Overridden by context_before/context_after if specified.",
    ),
  context_before: z.coerce
    .number()
    .optional()
    .describe(
      "Number of context lines to show BEFORE each match (like grep -B). Overrides 'context' for before-match lines.",
    ),
  context_after: z.coerce
    .number()
    .optional()
    .describe(
      "Number of context lines to show AFTER each match (like grep -A). Overrides 'context' for after-match lines.",
    ),
  case_insensitive: z
    .boolean()
    .optional()
    .describe(
      "Case-insensitive search (default: false). Only used for regex search.",
    ),
  multiline: z
    .boolean()
    .optional()
    .describe(
      "Enable multiline matching where . matches newlines and patterns can span lines (default: false).",
    ),
  max_results: z.coerce
    .number()
    .optional()
    .describe(
      "Maximum results (default: 300 for regex, 10 for query). Query limits are clamped to integers from 1 to 300.",
    ),
  offset: z.coerce
    .number()
    .optional()
    .describe(
      "Skip first N matches before returning results. Use with max_results for pagination (e.g. offset=100, max_results=100 for second page).",
    ),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .optional()
    .describe(
      "Output format: 'content' shows matching lines with context (default), 'files_with_matches' shows only file paths, 'count' shows match counts per file.",
    ),
};

export const searchSessionHistorySchema = {
  query: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "Literal terms or a safe-subset regular expression to search for.",
    ),
  mode: z
    .enum(["terms", "regex"])
    .optional()
    .describe(
      'Search mode. "terms" (default) requires all case-insensitive literal terms in one message; "regex" accepts a conservative linear-time subset.',
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("Maximum hits to return (default 5, maximum 5)."),
  role: z
    .enum(["user", "assistant"])
    .optional()
    .describe("Optionally restrict matches to one message role."),
  tool_name: z
    .string()
    .optional()
    .describe(
      "Optionally restrict matches to messages associated with this tool name.",
    ),
  scope: z
    .enum(["current", "handoff_source"])
    .optional()
    .describe(
      "Transcript scope: current (default) or the host-linked direct predecessor.",
    ),
};

export const diagnoseActivitySchema = {
  tool_name: z
    .string()
    .optional()
    .describe("Exact tool name to filter by, such as write_file"),
  path: z
    .string()
    .optional()
    .describe("Path text to match in recorded tool input or result evidence"),
  tool_call_id: z.string().optional().describe("Exact tool-call ID to inspect"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum evidence records to return (default 20, maximum 50)"),
};

export const readSessionExcerptSchema = {
  start_message_index: z.coerce
    .number()
    .int()
    .min(0)
    .describe("Inclusive zero-based start message index from a search hit."),
  end_message_index: z.coerce
    .number()
    .int()
    .min(0)
    .describe(
      "Inclusive zero-based end message index; maximum span is 10 messages.",
    ),
  snapshot_message_count: z.coerce
    .number()
    .int()
    .min(0)
    .describe("Snapshot message count returned by search_session_history."),
  snapshot_revision: z
    .string()
    .min(1)
    .describe("Snapshot revision returned by search_session_history."),
  scope: z
    .enum(["current", "handoff_source"])
    .optional()
    .describe("Transcript scope returned by search_session_history."),
  source_session_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Required for handoff_source and must equal the source_session_id returned by search_session_history.",
    ),
};

export const getDiagnosticsSchema = {
  path: z
    .string()
    .optional()
    .describe(
      "File path to get diagnostics for (omit for all workspace diagnostics)",
    ),
  severity: z
    .string()
    .optional()
    .describe(
      "Comma-separated severity filter (e.g. 'error', 'error,warning'). Options: error, warning, info/information, hint. Default: all severities.",
    ),
  source: z
    .string()
    .optional()
    .describe(
      "Comma-separated source filter (e.g. 'typescript', 'eslint'). Only show diagnostics from matching sources. Default: all sources.",
    ),
};

// ─── Write tools ─────────────────────────────────────────────────────────────

export const writeFileSchema = {
  path: z
    .string()
    .describe("File path (absolute or relative to workspace root)"),
  content: z.string().describe("Complete file content to write"),
  save_without_formatting: z
    .boolean()
    .optional()
    .describe(
      "Save the approved content without format-on-save or other ordinary save participants, then verify exact disk preservation.",
    ),
};

export const generateImageSchema = {
  prompt: z
    .string()
    .describe("Prompt describing the image or images to generate."),
  image_model: z
    .enum(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"])
    .optional()
    .describe(
      "Image model. Default: gpt-image-2.5-flare. Use Flare for fast exploration and user alignment. After the direction is approved, use Sunburst with the selected image as a reference for polished assets, concepts, or final images. Go directly to Sunburst when the direction is already settled, and honor an explicit user preference.",
    ),
  output_path: z
    .string()
    .optional()
    .describe(
      "Optional workspace-relative PNG, JPEG, or WebP file path or output directory. The extension can infer output_format. When omitted, generated images are shown in chat only and no files are written.",
    ),
  size: z
    .string()
    .optional()
    .describe(
      "Deprecated best-effort size/aspect hint retained for compatibility. Prefer output_size when exact supported dimensions are required. Cannot be combined with output_size.",
    ),
  output_size: z
    .string()
    .optional()
    .describe(
      "Structured output dimensions: auto or WIDTHxHEIGHT. Each edge must be a multiple of 16 and at most 3840 px, aspect ratio 1:3 to 3:1, and total pixels 655360 to 8294400. Public OpenAI API-key route only until Codex OAuth support is verified.",
    ),
  quality: z
    .enum(["auto", "low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe(
      "Rendering quality. xhigh and max are Image 2.5 options. Higher settings cost more and take longer. Public OpenAI API-key route only until Codex OAuth support is verified.",
    ),
  background: z
    .enum(["auto", "opaque", "transparent"])
    .optional()
    .describe(
      "Output background. Transparent output requires PNG or WebP. Public OpenAI API-key route only until Codex OAuth support is verified.",
    ),
  output_format: z
    .enum(["png", "jpeg", "webp"])
    .optional()
    .describe(
      "Generated file format. Defaults to PNG, or is inferred from a .png/.jpg/.jpeg/.webp output_path. Public OpenAI API-key route only until Codex OAuth support is verified.",
    ),
  output_compression: z.coerce
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "JPEG/WebP compression level from 0 to 100. Requires output_format jpeg or webp. Public OpenAI API-key route only until Codex OAuth support is verified.",
    ),
  action: z
    .enum(["auto", "generate", "edit"])
    .optional()
    .describe(
      "Whether to generate, edit, or let the model choose. edit requires exactly one explicit edit_image_path or edit_image_id. Public OpenAI API-key route only until Codex OAuth support is verified.",
    ),
  input_fidelity: z
    .enum(["low", "high"])
    .optional()
    .describe(
      "How strongly to preserve style and features from input images. Public OpenAI API-key route only until Codex OAuth support is verified.",
    ),
  edit_image_path: z
    .string()
    .optional()
    .describe(
      "Workspace-local image to edit. Mutually exclusive with edit_image_id. The source is never overwritten unless output_path separately names it and normal write approval permits that path.",
    ),
  edit_image_id: z
    .string()
    .optional()
    .describe(
      "Prior session image ID to edit. Mutually exclusive with edit_image_path.",
    ),
  mask_image_path: z
    .string()
    .optional()
    .describe(
      "Workspace-local PNG mask for the explicit edit target. Requires an alpha channel, matching target dimensions, and action edit. Mutually exclusive with mask_image_id.",
    ),
  mask_image_id: z
    .string()
    .optional()
    .describe(
      "Prior session PNG image ID to use as the edit mask. Requires an alpha channel, matching target dimensions, and action edit. Mutually exclusive with mask_image_path.",
    ),
  count: z.coerce
    .number()
    .optional()
    .describe("Number of images to generate. Default: 1. Maximum: 4."),
  reference_image_paths: z
    .array(z.string())
    .optional()
    .describe(
      "Workspace-relative or absolute paths to local reference images (PNG, JPEG, GIF, or WebP) to guide generation. Paths must resolve inside the workspace.",
    ),
  reference_image_ids: z
    .array(z.string())
    .optional()
    .describe(
      "IDs of prior images from this session to use as generation references, including user attachments and image tool results. Prefer use_recent_images when the relevant image is recent; explicit IDs follow image_N session order and errors list available IDs.",
    ),
  use_recent_images: z
    .union([z.boolean(), z.coerce.number()])
    .optional()
    .describe(
      "Use recent images from this session as references, including user attachments and image tool results. Pass true for up to 4 recent images, or a number for that many recent images.",
    ),
  timeout_seconds: z.coerce
    .number()
    .optional()
    .describe("Overall timeout in seconds. Default and maximum: 300."),
};

export const presentImagesSchema = {
  image_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Exact IDs of prior session images to show in the main chat transcript. IDs follow image_N session order. Use use_recent_images for the common case where the requested image was just returned by another tool.",
    ),
  use_recent_images: z
    .union([z.boolean(), z.coerce.number()])
    .optional()
    .describe(
      "Show recent session images in the main chat transcript. Pass true for the most recent image, false to disable recent selection, or a positive number for that many recent images. When both selectors are omitted, the most recent image is shown.",
    ),
};

export const saveSessionImageSchema = {
  image_id: z
    .string()
    .describe(
      "ID of the session image to save, such as image_3. IDs follow image_N session order across user attachments and image tool results; errors list the available IDs.",
    ),
  path: z
    .string()
    .describe(
      "Workspace-relative or absolute file path inside the workspace. The extension must match the image type (.png, .jpg/.jpeg, .gif, or .webp); when omitted, the matching extension is added. Missing parent directories are created.",
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      "Replace an existing file at path. Default: false, which refuses to overwrite.",
    ),
};

export const manageMemorySchema = {
  operation: z
    .enum(["remember", "update", "supersede", "forget", "restore", "undo"])
    .describe("Typed low-authority memory operation."),
  scope: z
    .enum(["global", "project"])
    .describe("Global user scope or current project scope."),
  source_evidence: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "Concise evidence supporting this mutation. Do not include secrets, credentials, raw tool output, or transient status.",
    ),
  kind: z
    .enum([
      "preference",
      "project_fact",
      "gotcha",
      "decision",
      "workflow_hint",
      "correction",
    ])
    .optional()
    .describe("Required when remembering a new record."),
  statement: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe("Concise durable statement for remember, update, or supersede."),
  target_id: z
    .string()
    .optional()
    .describe("Target record ID for update, supersede, forget, or restore."),
  conflict_key: z
    .string()
    .max(200)
    .optional()
    .describe("Stable exact conflict/deduplication key when known."),
  confidence: z.coerce
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Evidence confidence from 0 to 1."),
  expires_at: z.string().optional().describe("Optional ISO-8601 expiry time."),
  expected_revision: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Required compare-and-set revision when mutating an existing record.",
    ),
  undo_audit_event_id: z
    .string()
    .optional()
    .describe("Audit event ID to compensate when operation is undo."),
};

export const recallMemorySchema = {
  query: z.string().min(1).max(1000).describe("Memory search query."),
  scope: z
    .enum(["global", "project", "all"])
    .optional()
    .describe(
      "Scope filter. Defaults to all scopes available to this session.",
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum eligible records to return (default: 10, maximum: 20)."),
  minimum_score: z.coerce
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Minimum lexical relevance score (default: 0.2)."),
};

export const proposeMemorySchema = {
  tier: z
    .enum(["instructions", "skill", "command"])
    .describe(
      "Authoritative destination tier: instructions for durable rules, skill for reusable workflows, or command for slash-command prompts.",
    ),
  scope: z
    .enum(["global", "project"])
    .describe("Global user memory/config or current project memory/config."),
  operation: z
    .enum(["add", "update", "remove"])
    .describe("Whether to add, update, or remove remembered content."),
  title: z.string().describe("Short label shown on the approval card"),
  rationale: z
    .string()
    .describe(
      "Why this should be persisted across sessions; shown to the user.",
    ),
  content: z
    .string()
    .describe(
      "Markdown content to add or the replacement body for update/remove operations. For skills, pass the complete SKILL.md content. Use manage_memory for low-authority memory.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "Required for skill and command tiers. Lowercase hyphen identifier used for skill directory or command filename.",
    ),
  replaces: z
    .string()
    .optional()
    .describe(
      "Existing entry/section text to replace or remove. Matched with normalized whitespace.",
    ),
  skill_directory: z
    .enum([".agentlink/skills", ".agents/skills"])
    .optional()
    .describe(
      "Project skill destination directory (default: .agentlink/skills). Use .agents/skills for a tracked team skill. Valid only for tier=skill and scope=project; add/update/remove targets this exact directory without fallback.",
    ),
};

const applyDiffBlockOptionSchema = z
  .object({
    index: z.coerce
      .number()
      .int()
      .min(0)
      .describe(
        "Zero-based positional SEARCH/REPLACE block index, counting malformed block slots before the target",
      ),
    occurrence: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Select this 1-based matching occurrence for the block"),
    replace_all: z
      .literal(true)
      .optional()
      .describe("Replace every exact occurrence for this block"),
  })
  .refine(
    (option) =>
      (option.occurrence === undefined) !== (option.replace_all === undefined),
    "Each block option must specify exactly one of occurrence or replace_all",
  );

export const applyDiffSchema = {
  path: z
    .string()
    .describe("File path (absolute or relative to workspace root)"),
  diff: z.string().describe(APPLY_DIFF_INPUT_GRAMMAR),
  block_options: z
    .array(applyDiffBlockOptionSchema)
    .max(64)
    .optional()
    .describe(
      "Optional per-block controls. Use occurrence to select a 1-based exact/flexible/escape-normalized match, or replace_all to replace every exact match. Unlisted blocks retain unique-match safety.",
    ),
  atomic: z
    .boolean()
    .optional()
    .describe(
      "When true, require every parsed block to succeed and no malformed blocks before opening review or applying any change. The same requirement is revalidated under the write lock.",
    ),
  save_without_formatting: z
    .boolean()
    .optional()
    .describe(
      "Save the approved content without format-on-save or other ordinary save participants, then verify exact disk preservation.",
    ),
};

export const findAndReplaceSchema = {
  find: z
    .string()
    .describe("Text to find. Treated as a literal string unless regex=true."),
  replace: z.string().describe("Replacement text"),
  path: z
    .string()
    .optional()
    .describe(
      "Single file path to search in (absolute or relative to workspace root). Mutually exclusive with glob.",
    ),
  glob: z
    .string()
    .optional()
    .describe(
      "Glob pattern to match files (e.g. 'src/**/*.ts'). Mutually exclusive with path.",
    ),
  regex: z
    .boolean()
    .optional()
    .describe(
      "Regex search (default false). Replacement: $1-$99 captures, $$ literal dollar. Missing captures and $0 stay literal; unmatched optional groups become empty. Two-digit references fall back to one digit. Other dollar tokens stay literal.",
    ),
  max_replacements: z.coerce
    .number()
    .int()
    .optional()
    .describe(
      "Maximum allowed matches to replace. Must be a positive integer. If total matches exceed this value, no edits are applied and the tool returns a guardrail error payload.",
    ),
  save_without_formatting: z
    .boolean()
    .optional()
    .describe(
      "Save each changed file without format-on-save or other ordinary save participants, then verify exact disk preservation per file.",
    ),
};

export const renameSymbolSchema = {
  path: z
    .string()
    .describe(
      "File path containing the symbol (absolute or relative to workspace root)",
    ),
  line: z.coerce.number().describe("Line number of the symbol (1-indexed)"),
  column: z.coerce.number().describe("Column number of the symbol (1-indexed)"),
  new_name: z.string().describe("The new name for the symbol"),
};

// ─── Editor tools ────────────────────────────────────────────────────────────

export const getEditorStateSchema = {
  path: z.string().describe("Path to an existing file-backed VS Code editor"),
  offset: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe("First buffer line, default 1"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Buffer lines to return, default 100; previews are independently capped at 16,000 characters",
    ),
};

export const saveEditorSchema = {
  path: z.string().describe("Same editor path inspected with get_editor_state"),
  disk_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .describe(
      "Exact disk_hash from inspection; null means the file must still be missing",
    ),
  editor_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe("Exact editor_hash from inspection"),
  editor_version: z
    .number()
    .int()
    .min(0)
    .describe("Exact editor_version from inspection"),
};

export const openFileSchema = {
  path: z
    .string()
    .describe("File path (absolute or relative to workspace root)"),
  line: z.coerce
    .number()
    .optional()
    .describe("Line number to scroll to (1-indexed)"),
  column: z.coerce
    .number()
    .optional()
    .describe("Column number for cursor placement (1-indexed, requires line)"),
  end_line: z.coerce
    .number()
    .optional()
    .describe(
      "End line number for range selection (1-indexed, requires line). Highlights the range from line:column to end_line:end_column.",
    ),
  end_column: z.coerce
    .number()
    .optional()
    .describe(
      "End column number for range selection (1-indexed, requires end_line).",
    ),
};

export const showNotificationSchema = {
  message: z.string().describe("The notification message to display"),
  type: z
    .enum(["info", "warning", "error"])
    .optional()
    .describe("Notification type (default: 'info')"),
};

// ─── Agent coordination tools ───────────────────────────────────────────────

const backgroundQuestionAnswerValueSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.number(),
  z.boolean(),
]);

export const respondToBackgroundQuestionSchema = {
  request_id: z
    .string()
    .min(1)
    .describe(
      "Opaque request ID from the background-agent question interjection.",
    ),
  answers: z
    .record(z.string(), backgroundQuestionAnswerValueSchema)
    .describe(
      "Complete answer map keyed by the question IDs in the interjection.",
    ),
  notes: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Optional extra note per question ID, matching ask_user response notes.",
    ),
};

// ─── Terminal tools ──────────────────────────────────────────────────────────

export const executeCommandSchema = {
  command: z.string().describe("Shell command to execute"),
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory (absolute or relative to workspace root). Reused unnamed terminals are only selected when their current tracked cwd matches this value; otherwise a new terminal is created. Native commands compare directory identity, not just the path string, and re-enter stale directories while preserving logical paths. The payload does not run if recovery fails. Sandbox routes require cwd inside an active workspace root; an outside path returns retry_guidance code "sandbox_cwd_outside_workspace" before launch, with reviewed native execution offered only when policy permits.',
    ),
  terminal_id: z
    .string()
    .optional()
    .describe(
      "Run in a specific terminal by ID (returned from previous commands). Prefer omitting this for normal sequential commands so execute_command can reuse the default terminal automatically.",
    ),
  terminal_name: z
    .string()
    .optional()
    .describe(
      "Run in a named terminal, creating it if needed. Use a short purpose-based name (for example, 'Dev server', 'Unit tests', or 'Build') when the terminal should retain a stable identity; overlapping unnamed commands already allocate separate terminals when needed. Only Native Agent terminals retain shell mutations; sandbox calls start fresh shells even when named or targeted.",
    ),
  split_from: z
    .string()
    .optional()
    .describe(
      "Split a new terminal alongside an existing terminal or terminal group.",
    ),
  background: z
    .boolean()
    .optional()
    .describe(
      "Run without waiting for completion. Use for long-running processes like dev servers. Returns immediately with terminal_id.",
    ),
  timeout: z.coerce
    .number()
    .optional()
    .describe(
      "Timeout in seconds. Always set one for quick commands; omit it only when you intentionally want to wait indefinitely. Confirmed running commands remain observable by terminal ID; a Native Agent timeout before command-start confirmation closes the terminal and reports a launch-stage failure.",
    ),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Environment variables to set for this command (e.g. {"CI":"1"}). Merged with the terminal\'s base execution environment. Sandbox calls do not retain prior exports, so pass non-reserved variables on every call; values are literal, not shell-expanded. Sandbox PATH is host-managed: do not pass env.PATH; use an inline export PATH="/desired/bin:$PATH" in each reviewed command instead. Reserved overrides return sandbox_preparation_failed before launch, not an attestation failure, and do not permit native fallback.',
    ),
  temporary_home: z
    .literal(true)
    .optional()
    .describe(
      "Use a fresh writable per-command HOME for hermetic tests and disposable user state. Requires Approve for Me and sandbox execution; incompatible with background and require_escalated. The temporary home is empty and deleted after the command, while the host home remains readable by absolute path. Do not use for commands that need ~/.gitconfig, gh/npm/SSH/Docker credentials, or other user configuration.",
    ),
  sandbox_permissions: z
    .enum([
      "use_default",
      "with_additional_permissions",
      "require_managed_network",
      "require_escalated",
    ])
    .optional()
    .describe(
      'Execution authority intent. Omit or use "use_default" for the policy-selected route: native with normal command approval when Approve for Me is off; sandboxed when it is on. Default sandboxed commands use mediated public networking: unseen destinations pause for exact human approval and private/local destinations remain blocked. Use "with_additional_permissions" with additional_permissions for a narrow sandbox capability such as local listener binding. Recognized default-sandbox HOME/listener failures may return retry_guidance code "sandbox_missing_capabilities" with the exact narrow retry parameters; changed sandbox preparation security may return "sandbox_preparation_changed" with the changed fields; predictable Git metadata writers may return "protected_git_metadata" guidance before launch; unsafe symlink, hard-link, or node aliases in protected trees may return "sandbox_structural_protection" with the protected or unexpected path, node kind, and trusted-host inspection guidance. Matching Allow command rules may authorize the requested route and capabilities, but do not bypass unseen-destination approval; validation and explicit Forbidden rules still apply. "require_managed_network" is the explicit sandbox intent for one command that needs mediated public network access; Git-over-SSH, recognized gh TLS trust failures, and proxy-unaware DNS failures may return non-automatic retry_guidance codes "managed_network_ssh_git_transport", "managed_network_tls_trust", or "managed_network_proxy_unaware_dns". Direct pnpm store mismatches return evidence-led "pnpm_store_mismatch" guidance without automatic pinning or cleanup, while pre-launch Native Agent shell timeouts return "native_shell_startup_timeout". Never replace trust repair with disabled TLS verification. Use "require_escalated" only when execution must occur outside the sandbox. A recognized sandbox denial after process launch opens the normal one-shot human approval card before native replay; it never retries automatically. Every non-default intent requires a non-empty reason; an uncovered command requires approval.',
    ),
  additional_permissions: z
    .object({
      network: z
        .object({
          allow_local_binding: z
            .literal(true)
            .optional()
            .describe(
              "Allow this exact sandboxed command to bind TCP listeners. On macOS Seatbelt, bind authorization cannot be restricted to loopback addresses even though outbound traffic remains loopback/proxy constrained.",
            ),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional()
    .describe(
      "Exact additional sandbox capability delta. Currently supports network.allow_local_binding=true for commands that start local test or development servers.",
    ),

  files: z
    .array(
      z.object({
        name: z
          .string()
          .regex(/^[A-Za-z0-9_.-]{1,64}$/)
          .describe(
            "Logical name referenced in the command via $AL_FILE(name).",
          ),
        content: z
          .string()
          .describe("Full file content written to a temporary file."),
        ext: z
          .string()
          .regex(/^[A-Za-z0-9]{1,16}$/)
          .optional()
          .describe(
            "Optional extension hint for the temp filename (e.g. 'md', 'py'). No leading dot or separators. Omit when name already includes the extension.",
          ),
        mode: z
          .enum(["644", "755"])
          .optional()
          .describe(
            "Optional file mode. Use 755 only for scripts you execute directly.",
          ),
      }),
    )
    .max(8)
    .optional()
    .describe(
      "Throwaway temp files created before the command runs. Reference each path in command with $AL_FILE(name). Files live in the OS temp dir and are deleted after the command completes. Not a replacement for write_file; large or diff-worthy content should use write_file.",
    ),
  output_head: z.coerce
    .number()
    .optional()
    .describe(
      "Return only the first N lines of output. Overrides the default 200-line tail cap.",
    ),
  output_tail: z.coerce
    .number()
    .optional()
    .describe(
      "Return only the last N lines of output. Overrides the default 200-line tail cap.",
    ),
  output_offset: z.coerce
    .number()
    .optional()
    .describe(
      'Skip first N lines/entries before applying head/tail, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
    ),
  output_grep: z
    .string()
    .optional()
    .describe(
      "Filter output to lines matching this regex pattern (case-insensitive). Applied before head/tail. Use this instead of piping through grep.",
    ),
  output_grep_context: z.coerce
    .number()
    .optional()
    .describe(
      "Number of context lines around each grep match (like grep -C). Only used with output_grep.",
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      "Bypass command validation only for false-positive rejections of direct file-reading commands.",
    ),
  force_reason: z
    .string()
    .optional()
    .describe(
      "Required when force=true; explain why the rejection was a false positive.",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Short reason explaining why you need to run this command (shown to the user in the approval dialog). Keep it to one sentence.",
    ),
};

export const readOnlyExecuteCommandSchema = {
  command: z
    .string()
    .describe(
      "Recognized read-only shell command to execute. Unknown, mutating, redirected, networked, privileged, or opaque commands are rejected. AgentLink already disables interactive pagers. Use `rg --no-config <pattern> [path ...]`. Place Git helper guards after the subcommand: `git diff --no-ext-diff --no-textconv ...`, `git show --no-ext-diff --no-textconv ...`, `git log --no-ext-diff --no-textconv ...`, and `git blame --no-textconv ...`.",
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory inside the workspace. Defaults to the first workspace root. An outside path returns retry_guidance code "sandbox_cwd_outside_workspace"; this restricted profile cannot escalate to native execution.',
    ),
  output_head: executeCommandSchema.output_head,
  output_tail: executeCommandSchema.output_tail,
  output_offset: executeCommandSchema.output_offset,
  output_grep: executeCommandSchema.output_grep,
  output_grep_context: executeCommandSchema.output_grep_context,
  reason: executeCommandSchema.reason,
};

export const getTerminalOutputSchema = {
  terminal_id: z
    .string()
    .describe("Terminal ID returned by execute_command (e.g. 'term_3')"),
  command_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Command ID returned by execute_command. Pass it with terminal_id to read that command after terminal reuse; missing or expired commands never fall back to newer output. Omit for the latest command.",
    ),
  wait_seconds: z.coerce
    .number()
    .optional()
    .describe(
      "Wait up to N seconds before returning. Useful when a background command was just started and you want to avoid a double-call. Polls every 250ms and returns early when the command finishes or a user message interrupts the wait. The terminal command keeps running when interrupted unless kill is true.",
    ),
  kill: z
    .boolean()
    .optional()
    .describe(
      "Send Ctrl+C (SIGINT) to kill the running command. Returns captured output.",
    ),
  output_head: z.coerce
    .number()
    .optional()
    .describe("Return only the first N lines of output."),
  output_tail: z.coerce
    .number()
    .optional()
    .describe("Return only the last N lines of output."),
  output_offset: z.coerce
    .number()
    .optional()
    .describe("Skip first N lines before applying head/tail."),
  output_grep: z
    .string()
    .optional()
    .describe(
      "Filter output to lines matching this regex pattern (case-insensitive).",
    ),
  output_grep_context: z.coerce
    .number()
    .optional()
    .describe("Number of context lines around each grep match."),
};

export const closeTerminalsSchema = {
  names: z
    .array(z.string())
    .optional()
    .describe(
      "Terminal names to close (e.g. ['Server', 'Tests']). Omit to close all managed terminals.",
    ),
};

// ─── Advanced fleet tools ────────────────────────────────────────────────────

export const agentBudgetSchema = {
  maxTokens: z
    .number()
    .optional()
    .describe(
      "Cap on uncached input + output tokens summed across all API turns. Available for research tasks and ignored for review and writable task classes.",
    ),
  maxToolCalls: z
    .number()
    .optional()
    .describe(
      "Soft cap on successfully committed tool invocations. Interrupted/provisional tool streams are not charged.",
    ),
  maxApiTurns: z
    .number()
    .optional()
    .describe(
      "Soft cap on successful model API turns. Provider retry attempts are not charged.",
    ),
  maxElapsedMs: z
    .number()
    .optional()
    .describe("Wall-clock cap in milliseconds."),
  maxEstimatedCostUsd: z
    .number()
    .optional()
    .describe(
      "Estimated-cost cap in USD; only enforced when estimatedCostPerMillionTokens is also set.",
    ),
  estimatedCostPerMillionTokens: z.number().optional(),
  warningThresholdRatio: z
    .number()
    .optional()
    .describe(
      "Usage ratio at which the agent is nudged to start wrapping up. Automatic review budgets default to 0.8.",
    ),
  scope: z.enum(["session", "subtree", "goal"]).optional(),
};

export const agentBudgetDescription =
  "Optional resource caps for review and research task classes. Review agents receive generous tiered safety ceilings with an 80% wrap-up warning and a 1.5x emergency backstop. Research agents run uncapped by default (steer or kill them if they run too long); an explicit research budget supports every cap with a 3x hard backstop. Writable build, debug, design, verification, and general tasks run uncapped. Review token and cost caps remain ignored because explicit diffs may still be large.";

const fleetWorkflowKindSchema = z.enum([
  "structured_diff_review",
  "browser_verification",
  "best_of_n",
  "persistent_goal",
]);

export const detachBackgroundAgentSchema = {
  sessionId: z.string(),
};

export const startFleetWorkflowSchema = {
  kind: fleetWorkflowKindSchema,
  task: z.string(),
  message: z.string(),
  goalId: z.string().optional(),
  candidates: z
    .array(
      z.object({
        model: z.string().optional(),
        provider: z.string().optional(),
      }),
    )
    .optional(),
  budget: z
    .object(agentBudgetSchema)
    .describe(agentBudgetDescription)
    .optional(),
};

export const scheduleFleetWorkflowSchema = {
  name: z.string(),
  everyMinutes: z.number().optional(),
  eventType: z.string().optional(),
  workflow: z.record(z.string(), z.unknown()),
};

export const getFleetWorkflowResultSchema = {
  workflowId: z.string(),
  kind: fleetWorkflowKindSchema,
};

export const manageFleetAutomationsSchema = {
  action: z.enum(["list", "history", "enable", "disable", "delete"]),
  id: z.string().optional(),
};

// ─── Language tools ──────────────────────────────────────────────────────────

/** Common schema for go_to_definition, go_to_implementation, go_to_type_definition, get_hover */
export const positionSchema = {
  path: z
    .string()
    .describe("File path (absolute or relative to workspace root)"),
  line: z.coerce.number().describe("Line number (1-indexed)"),
  column: z.coerce.number().describe("Column number (1-indexed)"),
};

export const getReferencesSchema = {
  ...positionSchema,
  include_declaration: z
    .boolean()
    .optional()
    .describe("Include the declaration itself in results (default: true)"),
};

export const getSymbolsSchema = {
  path: z
    .string()
    .optional()
    .describe(
      "File path for document symbols (absolute or relative to workspace root)",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "Search query for workspace-wide symbol search. Used when path is omitted.",
    ),
};

export const getCompletionsSchema = {
  ...positionSchema,
  limit: z.coerce
    .number()
    .optional()
    .describe("Maximum number of completion items to return (default: 50)"),
};

export const getCodeActionsSchema = {
  ...positionSchema,
  end_line: z.coerce
    .number()
    .optional()
    .describe(
      "End line for range selection (1-indexed). Omit for actions at a single position.",
    ),
  end_column: z.coerce
    .number()
    .optional()
    .describe("End column for range selection (1-indexed)."),
  kind: z
    .string()
    .optional()
    .describe(
      "Filter by action kind (e.g. 'quickfix', 'refactor', 'refactor.extract', 'source.organizeImports', 'source.fixAll').",
    ),
  only_preferred: z
    .boolean()
    .optional()
    .describe("Only return preferred/recommended actions (default: false)."),
};

export const applyCodeActionSchema = {
  index: z.coerce
    .number()
    .describe(
      "0-based index of the action to apply (from get_code_actions result).",
    ),
};

export const getCallHierarchySchema = {
  ...positionSchema,
  direction: z
    .enum(["incoming", "outgoing", "both"])
    .describe(
      "Which direction to explore: 'incoming' (who calls this), 'outgoing' (what this calls), or 'both'.",
    ),
  max_depth: z.coerce
    .number()
    .optional()
    .describe(
      "Maximum recursion depth for call chain (default: 1, max: 3). Higher values return deeper call trees.",
    ),
};

export const getTypeHierarchySchema = {
  ...positionSchema,
  direction: z
    .enum(["supertypes", "subtypes", "both"])
    .describe(
      "Which direction to explore: 'supertypes' (parent types), 'subtypes' (child types), or 'both'.",
    ),
  max_depth: z.coerce
    .number()
    .optional()
    .describe(
      "Maximum recursion depth (default: 2, max: 5). Controls how many levels of the hierarchy to return.",
    ),
};

export const getInlayHintsSchema = {
  path: z
    .string()
    .describe("File path (absolute or relative to workspace root)"),
  start_line: z.coerce
    .number()
    .optional()
    .describe("Start of range (1-indexed, default: 1)."),
  end_line: z.coerce
    .number()
    .optional()
    .describe("End of range (1-indexed, default: end of file)."),
};

// ─── Search tools ────────────────────────────────────────────────────────────

export const composeSchema = {
  script: z
    .string()
    .min(1)
    .max(64 * 1024)
    .describe(
      "Sandboxed JavaScript function body; top-level return is supported. Use toolAllSettled([{ name, input }, ...]) for independent reads and summarize both fulfilled values and rejected reasons. toolAll([...]) is fail-fast: use only when every child must succeed. tool(name, input) returns one value or throws. Return selected fields, not raw child results.",
    ),
  description: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Optional one-line intent shown in the transcript header (maximum 200 characters).",
    ),
};
