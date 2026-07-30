import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createHash, randomUUID } from "node:crypto";

const MAX_FIELD_LENGTH = 500;
const MAX_SERIALIZED_ENTRY_BYTES = 4_000;
const FEEDBACK_FILE = "agentlink-feedback.jsonl";
const LEGACY_TOMBSTONE_FILE = "agentlink-feedback-deletions.jsonl";
const TOMBSTONE_DIRECTORY = "agentlink-feedback-deletions";
const TRIAGE_FILE = "agentlink-feedback-triage.jsonl";
const FEEDBACK_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

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

export type FeedbackPriority = (typeof FEEDBACK_PRIORITIES)[number];

export interface FeedbackEntry {
  timestamp: string;
  tool_name: string;
  feedback: string;
  session_id?: string;
  workspace?: string;
  extension_version: string;
  tool_params?: string;
  tool_result_summary?: string;
}

interface StoredFeedbackRecord extends FeedbackEntry {
  id: string;
  global_index: number;
}

export interface FeedbackRecord extends StoredFeedbackRecord {
  triaged: boolean;
  priority?: FeedbackPriority;
  triaged_at?: string;
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

function truncate(value: string, max = MAX_FIELD_LENGTH): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + "…(truncated)";
}

function appendLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(value) + "\n", "utf-8");
}

function fitFeedbackEntry(
  entry: FeedbackEntry & { id: string },
): FeedbackEntry & { id: string } {
  const fitted = { ...entry };
  const shrinkable = [
    "feedback",
    "tool_params",
    "tool_result_summary",
  ] as const;
  while (
    Buffer.byteLength(JSON.stringify(fitted) + "\n", "utf-8") >
    MAX_SERIALIZED_ENTRY_BYTES
  ) {
    const field = shrinkable.reduce<(typeof shrinkable)[number] | undefined>(
      (longest, candidate) => {
        const candidateLength = fitted[candidate]?.length ?? 0;
        const longestLength = longest ? (fitted[longest]?.length ?? 0) : 0;
        return candidateLength > longestLength ? candidate : longest;
      },
      undefined,
    );
    if (!field || !fitted[field]) {
      throw new Error(
        "Feedback entry metadata exceeds the atomic append limit.",
      );
    }
    const value = fitted[field];
    fitted[field] =
      value.slice(0, Math.floor(value.length / 2)) + "…(truncated)";
  }
  return fitted;
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

export function appendFeedback(entry: FeedbackEntry): FeedbackRecord {
  const safe = fitFeedbackEntry({
    ...entry,
    id: randomUUID(),
    feedback: truncate(entry.feedback, 2000),
    tool_params: entry.tool_params ? truncate(entry.tool_params) : undefined,
    tool_result_summary: entry.tool_result_summary
      ? truncate(entry.tool_result_summary)
      : undefined,
  });

  appendLine(getFeedbackPath(), safe);
  const record = readAllFeedbackRecords().find(
    (candidate) => candidate.id === safe.id,
  );
  if (!record) {
    throw new Error("Appended feedback could not be read back safely.");
  }
  return { ...record, triaged: false };
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
