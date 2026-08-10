import type { AgentMessage } from "./types.js";
import type { FinalMessageMarker } from "../shared/finalStatus.js";
import type { TodoItem } from "./todoTool.js";
import { scanMemoryText } from "../core/memory/memoryPolicy.js";
import { truncateMiddle } from "../util/truncateMiddle.js";

export const SESSION_HANDOFF_SCHEMA_VERSION = 1 as const;
export const SESSION_HANDOFF_SOURCE_PACK_MAX_CHARS = 48_000;
export const SESSION_HANDOFF_MARKDOWN_MAX_CHARS = 16_000;

const MAX_SUMMARY_CHARS = 16_000;
const MAX_CANONICAL_USER_MESSAGES = 12;
const MAX_CANONICAL_USER_MESSAGE_CHARS = 2_000;
const MAX_RECENT_SOURCE_TURNS = 16;
const MAX_RECENT_SOURCE_TURN_CHARS = 2_000;
const MAX_OLDER_DECISIONS = 8;
const MAX_OLDER_DECISION_CHARS = 1_000;
const MAX_TODO_CHARS = 8_000;

export interface SessionHandoffSections {
  objective: string;
  completedWork: string[];
  decisions: Array<{ decision: string; rationale?: string }>;
  workspaceState: string[];
  verification: string[];
  unresolved: string[];
  constraints: string[];
  nextActions: string[];
}

export interface SessionHandoffDraft {
  schemaVersion: typeof SESSION_HANDOFF_SCHEMA_VERSION;
  id: string;
  sourceSessionId: string;
  sourceProjectId: string;
  sourceTitle: string;
  /** CAS revision captured after the source session was durably flushed. */
  sourcePersistenceRevision: string;
  /** SHA-256 revision of the canonical source transcript snapshot. */
  sourceSnapshotRevision: string;
  /** In-process fast freshness check; not durable identity. */
  sourceRuntimeTranscriptRevision: number;
  createdAt: number;
  generatedBy: {
    providerId: string;
    model: string;
    fallbackUsed: boolean;
  };
  sections: SessionHandoffSections;
  markdown: string;
}

export interface PersistedSessionHandoff {
  schemaVersion: typeof SESSION_HANDOFF_SCHEMA_VERSION;
  handoffId: string;
  sourceSessionId: string;
  sourceProjectId: string;
  sourceTitle: string;
  sourcePersistenceRevision: string;
  sourceSnapshotRevision: string;
  createdAt: number;
  reviewedMarkdown: string;
}

export interface PersistedSessionLineage {
  schemaVersion: typeof SESSION_HANDOFF_SCHEMA_VERSION;
  /** Authoritative edge stored on the successor. */
  handoffSource?: PersistedSessionHandoff;
  /** CAS-protected source-side reservation/commit edge. */
  handoffSuccessor?: {
    sessionId: string;
    projectId: string;
    handoffId: string;
    titleAtCreation: string;
    state: "reserved" | "committed";
    createdAt: number;
    reservationExpiresAt?: number;
  };
  suggestion?: {
    dismissedThroughCondenseCount?: number;
    acceptedAt?: number;
  };
}

export interface SessionLineageSummary {
  source?: {
    sessionId: string;
    projectId: string;
    handoffId: string;
    titleAtCreation: string;
  };
  successor?: {
    sessionId: string;
    projectId: string;
    handoffId: string;
    titleAtCreation: string;
    state: "reserved" | "committed";
  };
}

export function normalizePersistedSessionLineage(
  value: unknown,
): PersistedSessionLineage | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SESSION_HANDOFF_SCHEMA_VERSION
  )
    return undefined;
  const handoffSource = normalizeHandoffSource(value.handoffSource);
  const handoffSuccessor = normalizeHandoffSuccessor(value.handoffSuccessor);
  const suggestion = normalizeSuggestion(value.suggestion);
  return handoffSource || handoffSuccessor || suggestion
    ? {
        schemaVersion: SESSION_HANDOFF_SCHEMA_VERSION,
        ...(handoffSource ? { handoffSource } : {}),
        ...(handoffSuccessor ? { handoffSuccessor } : {}),
        ...(suggestion ? { suggestion } : {}),
      }
    : undefined;
}

export function projectSessionLineageSummary(
  lineage: PersistedSessionLineage | undefined,
): SessionLineageSummary | undefined {
  if (!lineage) return undefined;
  const source = lineage.handoffSource
    ? {
        sessionId: lineage.handoffSource.sourceSessionId,
        projectId: lineage.handoffSource.sourceProjectId,
        handoffId: lineage.handoffSource.handoffId,
        titleAtCreation: lineage.handoffSource.sourceTitle,
      }
    : undefined;
  const successor = lineage.handoffSuccessor
    ? {
        sessionId: lineage.handoffSuccessor.sessionId,
        projectId: lineage.handoffSuccessor.projectId,
        handoffId: lineage.handoffSuccessor.handoffId,
        titleAtCreation: lineage.handoffSuccessor.titleAtCreation,
        state: lineage.handoffSuccessor.state,
      }
    : undefined;
  return source || successor
    ? { ...(source ? { source } : {}), ...(successor ? { successor } : {}) }
    : undefined;
}

export interface SessionHandoffSourcePack {
  schemaVersion: typeof SESSION_HANDOFF_SCHEMA_VERSION;
  source: {
    sessionId: string;
    projectId: string;
    title: string;
    mode: string;
    model: string;
  };
  latestSummary?: string;
  canonicalUserMessages: string[];
  recentSourceTurns: Array<{ role: "user" | "assistant"; text: string }>;
  olderDecisionCandidates: string[];
  todos: TodoItem[];
  finalMarker?: Pick<FinalMessageMarker, "status" | "summary">;
  omitted: {
    unsafeText: number;
    diagnosticMessages: number;
    nonTextBlocks: number;
    toolResultMessages: number;
  };
}

export interface BuildSessionHandoffSourcePackOptions {
  source: SessionHandoffSourcePack["source"];
  messages: readonly AgentMessage[];
  todos?: readonly TodoItem[];
  finalMarker?: FinalMessageMarker | null;
}

export type SessionHandoffValidationResult =
  | { ok: true; markdown: string }
  | {
      ok: false;
      code: "empty" | "too_large" | "sensitive_content";
      message: string;
    };

/**
 * Build a bounded, host-owned source pack. It never includes thinking, media,
 * tool calls/results, persisted diagnostics, or text detected as secret-like.
 */
export function buildSessionHandoffSourcePack(
  options: BuildSessionHandoffSourcePackOptions,
): SessionHandoffSourcePack {
  const omitted = {
    unsafeText: 0,
    diagnosticMessages: 0,
    nonTextBlocks: 0,
    toolResultMessages: 0,
  };
  const sourceTurns: Array<{ role: "user" | "assistant"; text: string }> = [];
  let latestSummary: string | undefined;

  for (const message of options.messages) {
    if (message.diagnosticOnly) {
      omitted.diagnosticMessages += 1;
      continue;
    }
    if (isToolResultMessage(message)) {
      omitted.toolResultMessages += 1;
      continue;
    }

    const text = extractSafeMessageText(message, omitted);
    if (!text) continue;
    if (message.isSummary) {
      latestSummary = truncateMiddle(text, MAX_SUMMARY_CHARS);
      continue;
    }
    if (message.isResumeContext) continue;
    sourceTurns.push({ role: message.role, text });
  }

  const userMessages = sourceTurns
    .filter((turn) => turn.role === "user")
    .map((turn) => truncateMiddle(turn.text, MAX_CANONICAL_USER_MESSAGE_CHARS));
  const canonicalUserMessages = selectCanonicalUserMessages(userMessages);
  const recentSourceTurns = sourceTurns
    .slice(-MAX_RECENT_SOURCE_TURNS)
    .map((turn) => ({
      ...turn,
      text: truncateMiddle(turn.text, MAX_RECENT_SOURCE_TURN_CHARS),
    }));
  const olderDecisionCandidates = sourceTurns
    .slice(0, Math.max(0, sourceTurns.length - MAX_RECENT_SOURCE_TURNS))
    .filter((turn) => looksLikeDecision(turn.text))
    .slice(-MAX_OLDER_DECISIONS)
    .map((turn) => truncateMiddle(turn.text, MAX_OLDER_DECISION_CHARS));

  const sourceTitle = sanitizeSourceTitle(options.source.title, omitted);
  const pack: SessionHandoffSourcePack = {
    schemaVersion: SESSION_HANDOFF_SCHEMA_VERSION,
    source: { ...options.source, title: sourceTitle },
    ...(latestSummary ? { latestSummary } : {}),
    canonicalUserMessages,
    recentSourceTurns,
    olderDecisionCandidates,
    todos: sanitizeTodos(options.todos ?? [], omitted),
    ...(options.finalMarker
      ? {
          finalMarker: {
            status: options.finalMarker.status,
            ...(options.finalMarker.summary &&
            isSafeText(options.finalMarker.summary)
              ? { summary: truncateMiddle(options.finalMarker.summary, 2_000) }
              : {}),
          },
        }
      : {}),
    omitted,
  };

  return fitSourcePack(pack);
}

export function buildDeterministicSessionHandoffMarkdown(
  pack: SessionHandoffSourcePack,
): string {
  const objective =
    pack.canonicalUserMessages.at(-1) ??
    pack.latestSummary ??
    "Continue the work described by the linked predecessor session.";
  const todos = renderTodos(pack.todos);
  const recentTurns = pack.recentSourceTurns
    .map((turn) => `- **${turn.role}**: ${turn.text}`)
    .join("\n");
  const decisions = renderBullets(
    pack.olderDecisionCandidates,
    "- None identified",
  );
  const verification = pack.finalMarker
    ? `- Latest final status: \`${pack.finalMarker.status}\`${
        pack.finalMarker.summary ? ` — ${pack.finalMarker.summary}` : ""
      }`
    : "- Not captured";

  return normalizeHandoffMarkdown(
    [
      "# Session handoff",
      "",
      "## Objective",
      objective,
      "",
      "## Completed work",
      pack.latestSummary ??
        "- Review the linked predecessor transcript when exact history is needed.",
      "",
      "## Decisions and rationale",
      decisions,
      "",
      "## Current workspace and verification",
      verification,
      "",
      "## Pending tasks",
      todos,
      "",
      "## Recent source turns",
      recentTurns || "- None captured",
      "",
      "## Next actions",
      "- Inspect the current workspace before acting; this handoff is historical source material.",
      "- Reconcile the task state with current files and tool results.",
    ].join("\n"),
  );
}

export function validateSessionHandoffMarkdown(
  markdown: string,
): SessionHandoffValidationResult {
  const normalized = markdown.trim();
  if (!normalized) {
    return {
      ok: false,
      code: "empty",
      message: "Handoff text cannot be empty.",
    };
  }
  if (normalized.length > SESSION_HANDOFF_MARKDOWN_MAX_CHARS) {
    return {
      ok: false,
      code: "too_large",
      message: `Handoff text exceeds ${SESSION_HANDOFF_MARKDOWN_MAX_CHARS} characters.`,
    };
  }
  const safety = scanMemoryText(normalized);
  if (!safety.safe) {
    return {
      ok: false,
      code: "sensitive_content",
      message: `Handoff text contains detected sensitive content (${safety.finding}).`,
    };
  }
  return { ok: true, markdown: normalized };
}

export function isSessionHandoffDraftFresh(
  draft: Pick<
    SessionHandoffDraft,
    "sourceRuntimeTranscriptRevision" | "sourceSnapshotRevision"
  >,
  current: { runtimeTranscriptRevision?: number; snapshotRevision: string },
): boolean {
  return (
    (current.runtimeTranscriptRevision === undefined ||
      current.runtimeTranscriptRevision ===
        draft.sourceRuntimeTranscriptRevision) &&
    current.snapshotRevision === draft.sourceSnapshotRevision
  );
}

export function toPersistedSessionHandoff(
  draft: SessionHandoffDraft,
  reviewedMarkdown: string,
): PersistedSessionHandoff {
  const validated = validateSessionHandoffMarkdown(reviewedMarkdown);
  if (!validated.ok)
    throw new Error(`Invalid handoff markdown: ${validated.code}`);
  return {
    schemaVersion: SESSION_HANDOFF_SCHEMA_VERSION,
    handoffId: draft.id,
    sourceSessionId: draft.sourceSessionId,
    sourceProjectId: draft.sourceProjectId,
    sourceTitle: draft.sourceTitle,
    sourcePersistenceRevision: draft.sourcePersistenceRevision,
    sourceSnapshotRevision: draft.sourceSnapshotRevision,
    createdAt: draft.createdAt,
    reviewedMarkdown: validated.markdown,
  };
}

function normalizeHandoffSource(
  value: unknown,
): PersistedSessionHandoff | undefined {
  if (!isRecord(value)) return undefined;
  const schemaVersion = value.schemaVersion;
  const handoffId = nonEmptyString(value.handoffId);
  const sourceSessionId = nonEmptyString(value.sourceSessionId);
  const sourceProjectId = nonEmptyString(value.sourceProjectId);
  const sourceTitle = nonEmptyString(value.sourceTitle);
  const safeSourceTitle =
    sourceTitle && isSafeText(sourceTitle) ? sourceTitle : undefined;
  const sourcePersistenceRevision = nonEmptyString(
    value.sourcePersistenceRevision,
  );
  const sourceSnapshotRevision = nonEmptyString(value.sourceSnapshotRevision);
  const createdAt = finiteNonNegative(value.createdAt);
  const reviewedMarkdown =
    typeof value.reviewedMarkdown === "string" ? value.reviewedMarkdown : "";
  const validMarkdown = validateSessionHandoffMarkdown(reviewedMarkdown);
  if (
    schemaVersion !== SESSION_HANDOFF_SCHEMA_VERSION ||
    !handoffId ||
    !sourceSessionId ||
    !sourceProjectId ||
    !safeSourceTitle ||
    !sourcePersistenceRevision ||
    !sourceSnapshotRevision ||
    createdAt === undefined ||
    !validMarkdown.ok
  ) {
    return undefined;
  }
  return {
    schemaVersion: SESSION_HANDOFF_SCHEMA_VERSION,
    handoffId,
    sourceSessionId,
    sourceProjectId,
    sourceTitle: safeSourceTitle,
    sourcePersistenceRevision,
    sourceSnapshotRevision,
    createdAt,
    reviewedMarkdown: validMarkdown.markdown,
  };
}

function normalizeHandoffSuccessor(
  value: unknown,
): PersistedSessionLineage["handoffSuccessor"] | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = nonEmptyString(value.sessionId);
  const projectId = nonEmptyString(value.projectId);
  const handoffId = nonEmptyString(value.handoffId);
  const titleAtCreation = nonEmptyString(value.titleAtCreation);
  const safeTitleAtCreation =
    titleAtCreation && isSafeText(titleAtCreation)
      ? titleAtCreation
      : undefined;
  const state =
    value.state === "reserved" || value.state === "committed"
      ? value.state
      : undefined;
  const createdAt = finiteNonNegative(value.createdAt);
  const reservationExpiresAt = finiteNonNegative(value.reservationExpiresAt);
  if (
    !sessionId ||
    !projectId ||
    !handoffId ||
    !safeTitleAtCreation ||
    !state ||
    createdAt === undefined
  )
    return undefined;
  return {
    sessionId,
    projectId,
    handoffId,
    titleAtCreation: safeTitleAtCreation,
    state,
    createdAt,
    ...(reservationExpiresAt !== undefined ? { reservationExpiresAt } : {}),
  };
}

function normalizeSuggestion(
  value: unknown,
): PersistedSessionLineage["suggestion"] | undefined {
  if (!isRecord(value)) return undefined;
  const dismissedThroughCondenseCount = nonNegativeInteger(
    value.dismissedThroughCondenseCount,
  );
  const acceptedAt = finiteNonNegative(value.acceptedAt);
  return dismissedThroughCondenseCount !== undefined || acceptedAt !== undefined
    ? {
        ...(dismissedThroughCondenseCount !== undefined
          ? { dismissedThroughCondenseCount }
          : {}),
        ...(acceptedAt !== undefined ? { acceptedAt } : {}),
      }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = finiteNonNegative(value);
  return number !== undefined && Number.isInteger(number) ? number : undefined;
}

function fitSourcePack(
  pack: SessionHandoffSourcePack,
): SessionHandoffSourcePack {
  const serializedLength = () => JSON.stringify(pack).length;
  while (serializedLength() > SESSION_HANDOFF_SOURCE_PACK_MAX_CHARS) {
    if (pack.recentSourceTurns.length > 2) {
      pack.recentSourceTurns.shift();
    } else if (pack.olderDecisionCandidates.length > 0) {
      pack.olderDecisionCandidates.shift();
    } else if (pack.canonicalUserMessages.length > 1) {
      // Preserve the newest user objective even when shrinking to a single turn.
      pack.canonicalUserMessages.shift();
    } else if (pack.latestSummary && pack.latestSummary.length > 2_000) {
      pack.latestSummary = truncateMiddle(
        pack.latestSummary,
        Math.floor(pack.latestSummary.length / 2),
      );
    } else {
      break;
    }
  }
  return pack;
}

function extractSafeMessageText(
  message: AgentMessage,
  omitted: SessionHandoffSourcePack["omitted"],
): string {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .flatMap((block) => {
            if (block.type === "text") return [block.text];
            omitted.nonTextBlocks += 1;
            return [];
          })
          .join("\n")
          .trim();
  if (!text) return "";
  if (!isSafeText(text)) {
    omitted.unsafeText += 1;
    return "";
  }
  return text;
}

function isToolResultMessage(message: AgentMessage): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_result")
  );
}

function isSafeText(text: string): boolean {
  return scanMemoryText(text).safe;
}

function sanitizeSourceTitle(
  title: string,
  omitted: SessionHandoffSourcePack["omitted"],
): string {
  if (isSafeText(title)) return truncateMiddle(title, 1_000);
  omitted.unsafeText += 1;
  return "Source session";
}

function selectCanonicalUserMessages(messages: string[]): string[] {
  if (messages.length <= MAX_CANONICAL_USER_MESSAGES) return messages;
  const first = messages[0]!;
  const remaining = MAX_CANONICAL_USER_MESSAGES - 2;
  return [
    first,
    `[... ${messages.length - remaining - 1} earlier user messages omitted ...]`,
    ...messages.slice(-remaining),
  ];
}

function looksLikeDecision(text: string): boolean {
  return /\b(?:decid(?:e|ed|ing)|prefer(?:red)?|choose|chosen|must|should|do not|don't|avoid|constraint)\b/i.test(
    text,
  );
}

function sanitizeTodos(
  todos: readonly TodoItem[],
  omitted: SessionHandoffSourcePack["omitted"],
): TodoItem[] {
  const safe = todos
    .map((todo) => sanitizeTodo(todo, omitted))
    .filter((todo): todo is TodoItem => todo !== null);
  let serialized = JSON.stringify(safe);
  while (serialized.length > MAX_TODO_CHARS && safe.length > 0) {
    safe.pop();
    serialized = JSON.stringify(safe);
  }
  return safe;
}

function sanitizeTodo(
  todo: TodoItem,
  omitted: SessionHandoffSourcePack["omitted"],
): TodoItem | null {
  if (!isSafeText(todo.content) || !isSafeText(todo.activeForm)) {
    omitted.unsafeText += 1;
    return null;
  }
  const children = (todo.children ?? [])
    .map((child) => sanitizeTodo(child, omitted))
    .filter((child): child is TodoItem => child !== null);
  return {
    ...todo,
    content: truncateMiddle(todo.content, 1_000),
    activeForm: truncateMiddle(todo.activeForm, 1_000),
    ...(children.length > 0 ? { children } : {}),
  };
}

function renderBullets(items: readonly string[], empty: string): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function renderTodos(todos: readonly TodoItem[], depth = 0): string {
  if (todos.length === 0) return "- None captured";
  return todos
    .flatMap((todo) => [
      `${"  ".repeat(depth)}- [${todo.status}] ${todo.content}`,
      ...(todo.children?.length ? [renderTodos(todo.children, depth + 1)] : []),
    ])
    .join("\n");
}

function normalizeHandoffMarkdown(markdown: string): string {
  const safeLines: string[] = [];
  for (const line of markdown.split("\n")) {
    if (!isSafeText(line)) continue;
    safeLines.push(line);
  }
  return truncateMiddle(
    safeLines.join("\n").trim(),
    SESSION_HANDOFF_MARKDOWN_MAX_CHARS,
  );
}
