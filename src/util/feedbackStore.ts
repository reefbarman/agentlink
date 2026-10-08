import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createHash, randomUUID } from "node:crypto";

const MAX_FIELD_LENGTH = 500;
const MAX_FEEDBACK_PREVIEW_LENGTH = 2_000;
const MAX_SERIALIZED_ENTRY_BYTES = 4_000;
/** Ceiling for one complete feedback record, including identity metadata. */
export const MAX_FEEDBACK_RECORD_BYTES = 128 * 1024;
const MIN_OPTIONAL_PREVIEW_LENGTH = 32;
const TRUNCATION_MARKER = "…(truncated)";
const CONTENT_CAPTURE_VERSION = 1;
const FEEDBACK_FILE = "agentlink-feedback.jsonl";
const LEGACY_TOMBSTONE_FILE = "agentlink-feedback-deletions.jsonl";
const TOMBSTONE_DIRECTORY = "agentlink-feedback-deletions";
const TRIAGE_FILE = "agentlink-feedback-triage.jsonl";
const CONTENT_DIRECTORY = "agentlink-feedback-content";
const FEEDBACK_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

/**
 * Version-1 canonical record field order. The complete-content digest covers
 * exactly this serialization; triage, global indices and capture metadata are
 * deliberately excluded because they are not part of the submitted report.
 */
const RECORD_FIELD_ORDER = [
  "id",
  "timestamp",
  "tool_name",
  "feedback",
  "extension_version",
  "category",
  "suspected_cause",
  "suggested_change",
  "observed_impact",
  "workaround",
  "observed_recurrence",
  "improvement_signal",
  "session_id",
  "workspace",
  "tool_params",
  "tool_result_summary",
] as const;

export const FEEDBACK_PREVIEW_FIELDS = [
  "feedback",
  "suspected_cause",
  "suggested_change",
  "observed_impact",
  "workaround",
  "observed_recurrence",
  "improvement_signal",
  "tool_params",
  "tool_result_summary",
] as const;
export type FeedbackPreviewField = (typeof FEEDBACK_PREVIEW_FIELDS)[number];
const PROPOSAL_FIELDS = ["suggested_change", "suspected_cause"] as const;
const EVIDENCE_FIELDS = [
  "feedback",
  "observed_impact",
  "workaround",
  "observed_recurrence",
  "improvement_signal",
  "tool_params",
  "tool_result_summary",
] as const;

function getStorePath(fileName: string): string {
  return path.join(os.homedir(), ".agentlink", fileName);
}

function getFeedbackPath(): string {
  return getStorePath(FEEDBACK_FILE);
}

function getLegacyTombstonePath(): string {
  return getStorePath(LEGACY_TOMBSTONE_FILE);
}

function getTombstoneDirectory(): string {
  return getStorePath(TOMBSTONE_DIRECTORY);
}

function getTriagePath(): string {
  return getStorePath(TRIAGE_FILE);
}

function getContentDirectory(): string {
  return getStorePath(CONTENT_DIRECTORY);
}

export type FeedbackPriority = (typeof FEEDBACK_PRIORITIES)[number];
export type FeedbackCategory = "bug" | "improvement" | "feature_request";

export interface FeedbackEntry {
  timestamp: string;
  tool_name: string;
  feedback: string;
  category?: FeedbackCategory;
  suspected_cause?: string;
  suggested_change?: string;
  observed_impact?: string;
  workaround?: string;
  observed_recurrence?: string;
  improvement_signal?: string;
  session_id?: string;
  workspace?: string;
  extension_version: string;
  tool_params?: string;
  tool_result_summary?: string;
}

export interface FeedbackContentCapture {
  version: number;
  storage: "inline" | "overflow";
  bytes: number;
  sha256: string;
  truncated_fields: FeedbackPreviewField[];
}

/**
 * complete: the line holds the whole verified-shape report;
 * preview: some fields were shortened/omitted and the full report is stored separately;
 * legacy_unverified: written before content capture, completeness unknown;
 * unsupported_capture: written by a newer capture version this reader cannot verify;
 * invalid_capture: version-1 capture metadata is malformed.
 */
export type FeedbackContentStatus =
  | "complete"
  | "preview"
  | "legacy_unverified"
  | "unsupported_capture"
  | "invalid_capture";

interface StoredFeedbackRecord extends FeedbackEntry {
  id: string;
  global_index: number;
  content_capture?: FeedbackContentCapture;
}

export interface FeedbackRecord extends StoredFeedbackRecord {
  triaged: boolean;
  priority?: FeedbackPriority;
  triaged_at?: string;
  content_status: FeedbackContentStatus;
}

export type FeedbackRecordErrorCode =
  | "feedback_too_large"
  | "feedback_metadata_too_large"
  | "feedback_storage_failed"
  | "feedback_recording_unknown";

/** Raised by appendFeedback. Only `feedback_recording_unknown` may have published. */
export class FeedbackRecordError extends Error {
  constructor(
    readonly code: FeedbackRecordErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FeedbackRecordError";
  }
}

export type FeedbackLookupErrorCode =
  | "not_found"
  | "ambiguous_record"
  | "content_unavailable"
  | "invalid_capture";

export class FeedbackLookupError extends Error {
  constructor(
    readonly code: FeedbackLookupErrorCode,
    message: string,
    readonly record?: FeedbackRecord,
  ) {
    super(message);
    this.name = "FeedbackLookupError";
  }
}

export interface FeedbackFullContent {
  record: FeedbackRecord;
  content: Record<string, unknown>;
  content_json: string;
  content_status: "complete" | "legacy_unverified" | "unsupported_capture";
  bytes: number;
  sha256: string;
}

export interface FeedbackReadFilter {
  tool_name?: string;
  triaged?: boolean;
  priorities?: FeedbackPriority[];
}

export interface TriageFeedbackRequest {
  ids: string[];
  triaged: boolean;
  priority?: FeedbackPriority;
}

export interface TriageFeedbackResult {
  updated: FeedbackRecord[];
  unknown_ids: string[];
}

interface FeedbackTriageEvent {
  id: string;
  triaged: boolean;
  priority?: FeedbackPriority;
  updated_at: string;
}

interface FeedbackTombstone {
  id: string;
  deleted_at: string;
}

export interface DeleteFeedbackRequest {
  ids?: string[];
  indices?: number[];
}

export interface DeleteFeedbackResult {
  removed: FeedbackRecord[];
  already_deleted_ids: string[];
  unknown_ids: string[];
  unknown_indices: number[];
}

function appendLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(value) + "\n", "utf-8");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Serializes the version-1 canonical record from any object carrying its fields. */
function serializeCanonicalRecord(source: object): string {
  const values = source as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of RECORD_FIELD_ORDER) {
    if (values[key] !== undefined) ordered[key] = values[key];
  }
  return JSON.stringify(ordered);
}

/** Local projection and capture keys that are never part of a submitted report. */
const NON_REPORT_KEYS = new Set([
  "global_index",
  "content_capture",
  "triaged",
  "priority",
  "triaged_at",
  "content_status",
]);

/**
 * Serializes a retained record that is not a verified v1 capture (legacy or a
 * newer capture version). Canonical fields keep their order; any other retained
 * report fields follow in stored order so newer schemas are not silently dropped.
 */
function serializeRetainedRecord(source: object): string {
  const values = source as Record<string, unknown>;
  const ordered = JSON.parse(serializeCanonicalRecord(source)) as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(values)) {
    if (key in ordered || NON_REPORT_KEYS.has(key) || value === undefined) {
      continue;
    }
    ordered[key] = value;
  }
  return JSON.stringify(ordered);
}

function previewValue(full: string, kept: number): string {
  if (kept >= full.length) return full;
  let end = kept;
  if (end > 0 && isHighSurrogate(full.charCodeAt(end - 1))) end -= 1;
  return full.slice(0, end) + TRUNCATION_MARKER;
}

type PreviewKept = Partial<Record<FeedbackPreviewField, number | null>>;

function buildIndexEntry(
  record: Record<string, unknown>,
  kept: PreviewKept,
  bytes: number,
  sha256: string,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  const truncatedFields: FeedbackPreviewField[] = [];
  for (const key of RECORD_FIELD_ORDER) {
    const value = record[key];
    if (value === undefined) continue;
    const field = key as FeedbackPreviewField;
    if (FEEDBACK_PREVIEW_FIELDS.includes(field) && typeof value === "string") {
      const limit = kept[field];
      if (limit === null) {
        truncatedFields.push(field);
        continue;
      }
      if (limit !== undefined && limit < value.length) {
        truncatedFields.push(field);
        entry[key] = previewValue(value, limit);
        continue;
      }
    }
    entry[key] = value;
  }
  const capture: FeedbackContentCapture = {
    version: CONTENT_CAPTURE_VERSION,
    storage: truncatedFields.length > 0 ? "overflow" : "inline",
    bytes,
    sha256,
    truncated_fields: FEEDBACK_PREVIEW_FIELDS.filter((field) =>
      truncatedFields.includes(field),
    ),
  };
  entry.content_capture = capture;
  return entry;
}

function longestKept(
  fields: readonly FeedbackPreviewField[],
  kept: PreviewKept,
  eligible: (field: FeedbackPreviewField, length: number) => boolean,
): FeedbackPreviewField | undefined {
  let best: FeedbackPreviewField | undefined;
  for (const field of fields) {
    const length = kept[field];
    if (length === undefined || length === null || !eligible(field, length)) {
      continue;
    }
    if (best === undefined || length > (kept[best] ?? 0)) best = field;
  }
  return best;
}

/**
 * Builds a bounded preview line. Old readers require timestamp, tool_name,
 * feedback and extension_version as strings, so feedback may shrink but is
 * never removed. Each iteration strictly reduces a kept length or removes an
 * optional field, so the loop terminates.
 */
function buildPreviewLine(
  record: Record<string, string>,
  bytes: number,
  sha256: string,
): { line: string; entry: Record<string, unknown> } {
  const kept: PreviewKept = {};
  for (const field of FEEDBACK_PREVIEW_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    kept[field] = Math.min(
      value.length,
      field === "feedback" ? MAX_FEEDBACK_PREVIEW_LENGTH : MAX_FIELD_LENGTH,
    );
  }
  for (;;) {
    const entry = buildIndexEntry(record, kept, bytes, sha256);
    const line = JSON.stringify(entry) + "\n";
    if (Buffer.byteLength(line, "utf-8") <= MAX_SERIALIZED_ENTRY_BYTES) {
      return { line, entry };
    }
    // Hypotheses and proposals give way before reproduction evidence.
    const proposal = longestKept(PROPOSAL_FIELDS, kept, () => true);
    if (proposal) {
      const length = kept[proposal] ?? 0;
      kept[proposal] =
        length > MIN_OPTIONAL_PREVIEW_LENGTH ? Math.floor(length / 2) : null;
      continue;
    }
    const evidence = longestKept(
      EVIDENCE_FIELDS,
      kept,
      (field, length) => field !== "feedback" || length > 0,
    );
    if (!evidence) {
      throw new FeedbackRecordError(
        "feedback_metadata_too_large",
        "Feedback identity metadata (such as tool_name) is too large to fit the bounded feedback index. Shorten it and resubmit.",
      );
    }
    const length = kept[evidence] ?? 0;
    kept[evidence] =
      evidence === "feedback" || length > MIN_OPTIONAL_PREVIEW_LENGTH
        ? Math.floor(length / 2)
        : null;
  }
}

function contentPath(id: string): string {
  // Derived only from the stable ID hash, never from persisted path data.
  return path.join(getContentDirectory(), `${sha256Hex(id)}.json`);
}

/** Ensures the content directory is a real directory, never a symlink. */
function assertContentDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("the full-content directory is not a regular directory");
  }
}

function writeOverflowContent(id: string, json: string): void {
  const directory = getContentDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertContentDirectory(directory);
  // Exclusive creation: an existing file is never overwritten.
  const descriptor = fs.openSync(contentPath(id), "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, json, "utf-8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readOverflowContent(
  id: string,
  capture: FeedbackContentCapture,
): string {
  const filePath = contentPath(id);
  let pathStat: fs.Stats;
  try {
    assertContentDirectory(path.dirname(filePath));
    pathStat = fs.lstatSync(filePath);
  } catch (error) {
    if (error instanceof Error && !("code" in error)) throw error;
    throw new Error("the full-content file is missing");
  }
  if (!pathStat.isFile()) {
    throw new Error("the full-content path is not a regular file");
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new Error("the full-content file could not be opened safely");
  }
  let json: string;
  try {
    // Validate the opened descriptor itself, so a concurrent replacement
    // cannot bypass the type and size bounds checked on the pathname.
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.dev !== pathStat.dev ||
      stat.ino !== pathStat.ino
    ) {
      throw new Error("the full-content file changed while it was opened");
    }
    if (stat.size !== capture.bytes || stat.size > MAX_FEEDBACK_RECORD_BYTES) {
      throw new Error("the full-content size does not match its index entry");
    }
    const buffer = Buffer.alloc(capture.bytes + 1);
    let total = 0;
    for (;;) {
      const read = fs.readSync(
        descriptor,
        buffer,
        total,
        buffer.length - total,
        total,
      );
      if (read === 0) break;
      total += read;
      if (total > capture.bytes) {
        throw new Error("the full-content size does not match its index entry");
      }
    }
    json = buffer.subarray(0, total).toString("utf-8");
  } finally {
    fs.closeSync(descriptor);
  }
  if (
    Buffer.byteLength(json, "utf-8") !== capture.bytes ||
    sha256Hex(json) !== capture.sha256
  ) {
    throw new Error("the full-content digest does not match its index entry");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("the full-content file is not valid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { id?: unknown }).id !== id ||
    serializeCanonicalRecord(parsed) !== json
  ) {
    throw new Error("the full-content record identity does not match");
  }
  return json;
}

function isValidCapture(value: unknown): value is FeedbackContentCapture {
  if (typeof value !== "object" || value === null) return false;
  const capture = value as Record<string, unknown>;
  const fields = capture.truncated_fields;
  if (
    !Array.isArray(fields) ||
    !fields.every(
      (field) =>
        typeof field === "string" &&
        FEEDBACK_PREVIEW_FIELDS.includes(field as FeedbackPreviewField),
    ) ||
    !Number.isSafeInteger(capture.bytes) ||
    (capture.bytes as number) <= 0 ||
    (capture.bytes as number) > MAX_FEEDBACK_RECORD_BYTES ||
    typeof capture.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(capture.sha256)
  ) {
    return false;
  }
  return (
    (capture.storage === "inline" && fields.length === 0) ||
    (capture.storage === "overflow" && fields.length > 0)
  );
}

function contentStatusOf(entry: StoredFeedbackRecord): FeedbackContentStatus {
  const capture = (entry as { content_capture?: unknown }).content_capture;
  if (capture === undefined) return "legacy_unverified";
  const version =
    typeof capture === "object" && capture !== null
      ? (capture as { version?: unknown }).version
      : undefined;
  if (version !== CONTENT_CAPTURE_VERSION) {
    return typeof version === "number" && version > CONTENT_CAPTURE_VERSION
      ? "unsupported_capture"
      : "invalid_capture";
  }
  if (!isValidCapture(capture)) return "invalid_capture";
  if (capture.storage === "overflow") return "preview";
  // Inline captures claim the retained line is the complete report; verify it
  // before any projection (list, sidebar, triage) labels it complete.
  const json = serializeCanonicalRecord(entry);
  return Buffer.byteLength(json, "utf-8") === capture.bytes &&
    sha256Hex(json) === capture.sha256
    ? "complete"
    : "invalid_capture";
}

function resolveFullContent(record: FeedbackRecord): FeedbackFullContent {
  const unavailable = (reason: string) =>
    new FeedbackLookupError(
      "content_unavailable",
      `Full feedback content is unavailable: ${reason}. Only the retained preview can be shown, and it is partial.`,
      record,
    );
  const status = record.content_status;
  if (status === "invalid_capture") {
    throw new FeedbackLookupError(
      "invalid_capture",
      "Feedback content capture metadata is malformed or does not match the retained content; the retained preview cannot be verified as complete.",
      record,
    );
  }
  let json: string;
  if (status === "preview") {
    try {
      json = readOverflowContent(record.id, record.content_capture!);
    } catch (error) {
      throw unavailable(error instanceof Error ? error.message : String(error));
    }
  } else if (status === "complete") {
    json = serializeCanonicalRecord(record);
    const capture = record.content_capture!;
    if (
      Buffer.byteLength(json, "utf-8") !== capture.bytes ||
      sha256Hex(json) !== capture.sha256
    ) {
      throw unavailable("the inline record does not match its digest");
    }
  } else {
    json = serializeRetainedRecord(record);
  }
  return {
    record,
    content: JSON.parse(json) as Record<string, unknown>,
    content_json: json,
    content_status:
      status === "preview"
        ? "complete"
        : (status as FeedbackFullContent["content_status"]),
    bytes: Buffer.byteLength(json, "utf-8"),
    sha256: sha256Hex(json),
  };
}

function tombstonePath(id: string): string {
  const fileName = createHash("sha256").update(id).digest("hex") + ".json";
  return path.join(getTombstoneDirectory(), fileName);
}

function isFeedbackPriority(value: unknown): value is FeedbackPriority {
  return FEEDBACK_PRIORITIES.includes(value as FeedbackPriority);
}

function appendTriageEvent(event: FeedbackTriageEvent): void {
  appendLine(getTriagePath(), event);
}

function readLatestTriageEvents(): Map<string, FeedbackTriageEvent> {
  const triagePath = getTriagePath();
  if (!fs.existsSync(triagePath)) return new Map();

  const latest = new Map<string, FeedbackTriageEvent>();
  for (const rawLine of fs.readFileSync(triagePath, "utf-8").split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    try {
      const event = JSON.parse(rawLine) as FeedbackTriageEvent;
      if (
        typeof event === "object" &&
        event !== null &&
        typeof event.id === "string" &&
        event.id.trim() &&
        typeof event.triaged === "boolean" &&
        typeof event.updated_at === "string" &&
        ((!event.triaged && event.priority === undefined) ||
          (event.triaged && isFeedbackPriority(event.priority)))
      ) {
        latest.set(event.id, event);
      }
    } catch {
      // Skip malformed metadata without hiding feedback.
    }
  }
  return latest;
}

function projectFeedbackRecord(
  entry: StoredFeedbackRecord,
  triageEvents: ReadonlyMap<string, FeedbackTriageEvent>,
): FeedbackRecord {
  const triage = triageEvents.get(entry.id);
  return {
    ...entry,
    triaged: triage?.triaged ?? false,
    priority: triage?.priority,
    triaged_at: triage?.triaged ? triage.updated_at : undefined,
    content_status: contentStatusOf(entry),
  };
}

function appendTombstone(tombstone: FeedbackTombstone): boolean {
  const directory = getTombstoneDirectory();
  fs.mkdirSync(directory, { recursive: true });
  let descriptor: number;
  try {
    descriptor = fs.openSync(tombstonePath(tombstone.id), "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify(tombstone) + "\n", "utf-8");
  } finally {
    fs.closeSync(descriptor);
  }
  return true;
}

/**
 * Appends one feedback report without losing accepted content. The bounded
 * index line keeps the existing atomic-append ceiling; when its preview must
 * shorten or omit fields, the complete canonical record is first written to an
 * immutable ID-addressed file. Readers only discover records via the index.
 */
export function appendFeedback(entry: FeedbackEntry): FeedbackRecord {
  const id = randomUUID();
  const json = serializeCanonicalRecord({ ...entry, id });
  const bytes = Buffer.byteLength(json, "utf-8");
  const record = JSON.parse(json) as Record<string, string>;
  if (bytes > MAX_FEEDBACK_RECORD_BYTES) {
    const fieldBytes: Record<string, number> = {};
    for (const [key, value] of Object.entries(record)) {
      fieldBytes[key] = Buffer.byteLength(value, "utf-8");
    }
    throw new FeedbackRecordError(
      "feedback_too_large",
      `Feedback record is ${bytes} bytes, above the ${MAX_FEEDBACK_RECORD_BYTES}-byte limit. Nothing was recorded; shorten the largest fields or split the report.`,
      {
        actual_bytes: bytes,
        max_bytes: MAX_FEEDBACK_RECORD_BYTES,
        field_bytes: fieldBytes,
      },
    );
  }
  const sha256 = sha256Hex(json);
  const { line, entry: indexEntry } = buildPreviewLine(record, bytes, sha256);
  const capture = indexEntry.content_capture as FeedbackContentCapture;

  if (capture.storage === "overflow") {
    try {
      writeOverflowContent(id, json);
      readOverflowContent(id, capture);
    } catch (error) {
      throw new FeedbackRecordError(
        "feedback_storage_failed",
        `Feedback was not recorded: its full content could not be stored safely (${error instanceof Error ? error.message : String(error)}).`,
        { id },
      );
    }
  }

  const unknown = (reason: string) =>
    new FeedbackRecordError(
      "feedback_recording_unknown",
      `Feedback recording state is unknown: ${reason}.`,
      { id },
    );
  try {
    fs.mkdirSync(path.dirname(getFeedbackPath()), { recursive: true });
    fs.appendFileSync(getFeedbackPath(), line, "utf-8");
  } catch (error) {
    throw unknown(
      `the index append failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let published: FeedbackRecord;
  try {
    const matches = readAllFeedbackRecords().filter(
      (candidate) => candidate.id === id,
    );
    if (matches.length !== 1) {
      throw new Error(`found ${matches.length} index entries for the ID`);
    }
    published = projectFeedbackRecord(matches[0]!, new Map());
    const full = resolveFullContent(published);
    if (full.sha256 !== sha256 || full.content_json !== json) {
      throw new Error("read-back content differs from the submission");
    }
  } catch (error) {
    throw unknown(
      `read-back verification failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return published;
}

/**
 * Returns the complete verified content for one active feedback report.
 * Hidden, unknown and duplicate IDs are explicit errors.
 */
export function readFeedbackContent(id: string): FeedbackFullContent {
  const matches = readFeedback().filter((entry) => entry.id === id);
  if (matches.length === 0) {
    throw new FeedbackLookupError(
      "not_found",
      `No active feedback entry has ID ${id}.`,
    );
  }
  if (matches.length > 1) {
    throw new FeedbackLookupError(
      "ambiguous_record",
      `Multiple active feedback index entries share ID ${id}; refusing to choose one.`,
    );
  }
  return resolveFullContent(matches[0]!);
}

function canonicalLegacyEntry(entry: FeedbackEntry): string {
  return JSON.stringify({
    timestamp: entry.timestamp,
    tool_name: entry.tool_name,
    feedback: entry.feedback,
    session_id: entry.session_id,
    workspace: entry.workspace,
    extension_version: entry.extension_version,
    tool_params: entry.tool_params,
    tool_result_summary: entry.tool_result_summary,
  });
}

function legacyFeedbackId(
  canonicalEntry: string,
  duplicateOrdinal: number,
): string {
  return `legacy-${createHash("sha256")
    .update(canonicalEntry)
    .update("\0")
    .update(String(duplicateOrdinal))
    .digest("hex")}`;
}

function readAllFeedbackRecords(): StoredFeedbackRecord[] {
  const feedbackPath = getFeedbackPath();
  if (!fs.existsSync(feedbackPath)) return [];

  const raw = fs.readFileSync(feedbackPath, "utf-8");
  const records: StoredFeedbackRecord[] = [];
  const duplicateOrdinals = new Map<string, number>();

  for (const rawLine of raw.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    try {
      const entry = JSON.parse(rawLine) as FeedbackEntry & { id?: unknown };
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof entry.timestamp !== "string" ||
        typeof entry.tool_name !== "string" ||
        typeof entry.feedback !== "string" ||
        typeof entry.extension_version !== "string"
      ) {
        continue;
      }
      const canonicalEntry = canonicalLegacyEntry(entry);
      const duplicateOrdinal = duplicateOrdinals.get(canonicalEntry) ?? 0;
      duplicateOrdinals.set(canonicalEntry, duplicateOrdinal + 1);
      const id =
        typeof entry.id === "string" && entry.id.trim()
          ? entry.id
          : legacyFeedbackId(canonicalEntry, duplicateOrdinal);
      records.push({ ...entry, id, global_index: records.length });
    } catch {
      // Skip malformed lines while preserving the global index among valid entries.
    }
  }

  return records;
}

function collectTombstoneIds(raw: string, ids: Set<string>): void {
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const tombstone = JSON.parse(line) as FeedbackTombstone;
      if (typeof tombstone.id === "string" && tombstone.id.trim()) {
        ids.add(tombstone.id);
      }
    } catch {
      // Skip malformed tombstones without hiding active feedback.
    }
  }
}

function readLegacyDeletedIds(): Set<string> {
  const ids = new Set<string>();
  const legacyPath = getLegacyTombstonePath();
  if (fs.existsSync(legacyPath)) {
    collectTombstoneIds(fs.readFileSync(legacyPath, "utf-8"), ids);
  }
  return ids;
}

function readDeletedTombstoneNames(): Set<string> {
  const directory = getTombstoneDirectory();
  if (!fs.existsSync(directory)) return new Set();
  return new Set(
    fs.readdirSync(directory).filter((name) => name.endsWith(".json")),
  );
}

function tombstoneName(id: string): string {
  return path.basename(tombstonePath(id));
}

export function readFeedback(
  filter: string | FeedbackReadFilter = {},
): FeedbackRecord[] {
  const normalized =
    typeof filter === "string" ? { tool_name: filter } : filter;
  const legacyDeletedIds = readLegacyDeletedIds();
  const deletedTombstones = readDeletedTombstoneNames();
  const triageEvents = readLatestTriageEvents();
  return readAllFeedbackRecords()
    .filter(
      (entry) =>
        !legacyDeletedIds.has(entry.id) &&
        !deletedTombstones.has(tombstoneName(entry.id)),
    )
    .map((entry) => projectFeedbackRecord(entry, triageEvents))
    .filter(
      (entry) =>
        (normalized.tool_name === undefined ||
          entry.tool_name === normalized.tool_name) &&
        (normalized.triaged === undefined ||
          entry.triaged === normalized.triaged) &&
        (normalized.priorities === undefined ||
          (entry.priority !== undefined &&
            normalized.priorities.includes(entry.priority))),
    );
}

export function triageFeedback(
  request: TriageFeedbackRequest,
): TriageFeedbackResult {
  if (
    !request.ids.length ||
    request.ids.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new Error(
      "Feedback ids must be a non-empty array of non-empty strings.",
    );
  }
  if (request.triaged && !isFeedbackPriority(request.priority)) {
    throw new Error("Triaged feedback requires a priority from P0 to P3.");
  }
  if (!request.triaged && request.priority !== undefined) {
    throw new Error("Untriaged feedback cannot have a priority.");
  }

  const activeById = new Map(readFeedback().map((entry) => [entry.id, entry]));
  const updated: FeedbackRecord[] = [];
  const unknownIds: string[] = [];
  for (const id of new Set(request.ids)) {
    const active = activeById.get(id);
    if (!active) {
      unknownIds.push(id);
      continue;
    }
    const updatedAt = new Date().toISOString();
    appendTriageEvent({
      id,
      triaged: request.triaged,
      priority: request.triaged ? request.priority : undefined,
      updated_at: updatedAt,
    });
    updated.push({
      ...active,
      triaged: request.triaged,
      priority: request.triaged ? request.priority : undefined,
      triaged_at: request.triaged ? updatedAt : undefined,
    });
  }
  return { updated, unknown_ids: unknownIds };
}

export function deleteFeedback(
  request: DeleteFeedbackRequest | number[],
): DeleteFeedbackResult {
  const normalized = Array.isArray(request) ? { indices: request } : request;
  const hasIds = normalized.ids !== undefined;
  const hasIndices = normalized.indices !== undefined;
  if (hasIds === hasIndices) {
    throw new Error("Provide exactly one of feedback ids or global indices.");
  }
  if (
    hasIds &&
    (!normalized.ids?.length ||
      normalized.ids.some((id) => typeof id !== "string" || !id.trim()))
  ) {
    throw new Error(
      "Feedback ids must be a non-empty array of non-empty strings.",
    );
  }
  if (
    hasIndices &&
    (!normalized.indices?.length ||
      normalized.indices.some((index) => !Number.isInteger(index) || index < 0))
  ) {
    throw new Error(
      "Feedback indices must be a non-empty array of non-negative integers.",
    );
  }

  const allRecords = readAllFeedbackRecords();
  const activeRecordById = new Map(
    readFeedback().map((record) => [record.id, record]),
  );
  const recordById = new Map(allRecords.map((record) => [record.id, record]));
  const unknownIndices = hasIndices
    ? [
        ...new Set(
          normalized.indices?.filter((index) => !allRecords[index]) ?? [],
        ),
      ]
    : [];
  const requestedIds = hasIds
    ? [...new Set(normalized.ids)]
    : [
        ...new Set(
          normalized.indices
            ?.map((index) => allRecords[index]?.id)
            .filter((id): id is string => id !== undefined) ?? [],
        ),
      ];

  const removed: FeedbackRecord[] = [];
  const alreadyDeletedIds: string[] = [];
  const unknownIds: string[] = [];
  const legacyDeletedIds = readLegacyDeletedIds();
  for (const id of requestedIds) {
    const record = recordById.get(id);
    if (!record) {
      unknownIds.push(id);
      continue;
    }
    if (legacyDeletedIds.has(id)) {
      alreadyDeletedIds.push(id);
      continue;
    }
    const appended = appendTombstone({
      id,
      deleted_at: new Date().toISOString(),
    });
    if (!appended) {
      alreadyDeletedIds.push(id);
      continue;
    }
    const activeRecord = activeRecordById.get(id);
    if (!activeRecord) {
      throw new Error(
        `Active feedback record disappeared during deletion: ${id}`,
      );
    }
    removed.push(activeRecord);
  }

  return {
    removed,
    already_deleted_ids: alreadyDeletedIds,
    unknown_ids: unknownIds,
    unknown_indices: unknownIndices,
  };
}
