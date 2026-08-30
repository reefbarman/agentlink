import type {
  ImportMemoryRecordCandidate,
  ImportMemoryRecordsRequest,
  MemoryKind,
  MemoryScope,
} from "@agentlink/protocol/autonomous-memory";

import { createHash } from "node:crypto";

export const LEGACY_MEMORY_IMPORTER_SCHEMA_VERSION = 1;
export const LEGACY_MEMORY_MAX_BLOCK_CHARS = 1_000;

export interface LegacyMemoryImportSource {
  sourceKey: string;
  filePath: string;
  content: string;
  scope: MemoryScope;
  observedAt: string;
}

export interface LegacyMemoryBlock {
  ordinal: number;
  headingOrdinal: number;
  startLine: number;
  endLine: number;
  headingPath: string[];
  originalText: string;
  statement: string;
  addedAt?: string;
}

export function getLegacyMemorySourceRevision(content: string): string {
  return sha256(normalizeLineEndings(content));
}

export function parseLegacyMemoryMarkdown(
  content: string,
): LegacyMemoryBlock[] {
  const normalized = normalizeLineEndings(content);
  if (normalized.includes("\0")) {
    throw new Error("Legacy memory contains a NUL character");
  }

  const lines = normalized.split("\n");
  const headingStack: string[] = [];
  const headingOrdinals = new Map<string, number>();
  const blocks: LegacyMemoryBlock[] = [];
  let pending: {
    lines: string[];
    startLine: number;
    headingPath: string[];
  } | null = null;

  const flush = (endLine: number): void => {
    if (!pending) return;
    const originalText = pending.lines.join("\n").trim();
    if (originalText) {
      const statement = normalizeBlockStatement(originalText);
      if (statement.length > LEGACY_MEMORY_MAX_BLOCK_CHARS) {
        throw new Error(
          `Legacy memory block at lines ${pending.startLine}-${endLine} exceeds ${LEGACY_MEMORY_MAX_BLOCK_CHARS} characters`,
        );
      }
      const headingKey = pending.headingPath.join("\0");
      const headingOrdinal = headingOrdinals.get(headingKey) ?? 0;
      headingOrdinals.set(headingKey, headingOrdinal + 1);
      blocks.push({
        ordinal: blocks.length,
        headingOrdinal,
        startLine: pending.startLine,
        endLine,
        headingPath: [...pending.headingPath],
        originalText,
        statement,
      });
    }
    pending = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const lineNumber = index + 1;
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush(lineNumber - 1);
      const level = heading[1]!.length;
      headingStack.splice(level - 1);
      headingStack[level - 1] = heading[2]!.trim();
      continue;
    }

    const addedMarker = /^\s*<!--\s*added\s+([^>]+?)\s*-->\s*$/i.exec(line);
    if (addedMarker) {
      flush(lineNumber - 1);
      const addedAt = parseAddedDate(addedMarker[1]!, lineNumber);
      const target = blocks.at(-1);
      if (!target || target.addedAt) {
        throw new Error(
          `Legacy memory added-date marker at line ${lineNumber} has no preceding block`,
        );
      }
      target.addedAt = addedAt;
      target.endLine = lineNumber;
      continue;
    }
    if (/<!--\s*added\b/i.test(line)) {
      throw new Error(
        `Malformed legacy memory added-date marker at line ${lineNumber}`,
      );
    }

    if (!line.trim()) {
      flush(lineNumber - 1);
      continue;
    }

    const listItem = /^\s*(?:[-*+] |\d+[.)] )/.test(line);
    if (listItem) flush(lineNumber - 1);
    if (!pending) {
      pending = {
        lines: [],
        startLine: lineNumber,
        headingPath: headingStack.filter(Boolean),
      };
    }
    pending.lines.push(line);
  }
  flush(lines.length);
  return blocks;
}

export function getLegacyMemoryImportIds(
  sourceKey: string,
  sourceRevision: string,
): { checkpointId: string; snapshotId: string } {
  const sourceIdentity = stableId(sourceKey, sourceRevision);
  return {
    checkpointId: `legacy-memory-import:${sourceIdentity}`,
    snapshotId: `legacy-memory-snapshot:${sourceIdentity}`,
  };
}

export function buildLegacyMemoryImportRequest(
  source: LegacyMemoryImportSource,
): ImportMemoryRecordsRequest {
  if (!source.sourceKey.trim() || !source.filePath.trim()) {
    throw new Error("Legacy memory source identity is required");
  }
  if (!source.scope.id.trim() || !source.observedAt.trim()) {
    throw new Error(
      "Legacy memory source scope and observed time are required",
    );
  }

  const sourceRevision = getLegacyMemorySourceRevision(source.content);
  const ids = getLegacyMemoryImportIds(source.sourceKey, sourceRevision);
  const blocks = parseLegacyMemoryMarkdown(source.content);
  return {
    checkpointId: ids.checkpointId,
    snapshotId: ids.snapshotId,
    snapshotTag: `pre-import:${source.sourceKey}:${sourceRevision}`,
    sourceKey: source.sourceKey,
    sourceRevision,
    importerSchemaVersion: LEGACY_MEMORY_IMPORTER_SCHEMA_VERSION,
    records: blocks.map((block) =>
      toImportCandidate(source, sourceRevision, block),
    ),
  };
}

function toImportCandidate(
  source: LegacyMemoryImportSource,
  sourceRevision: string,
  block: LegacyMemoryBlock,
): ImportMemoryRecordCandidate {
  const heading = block.headingPath.join(" > ");
  const evidence = [
    `Legacy memory source: ${source.filePath}`,
    `Source revision (SHA-256): ${groupDigest(sourceRevision)}`,
    `Lines: ${block.startLine}-${block.endLine}`,
    ...(heading ? [`Heading: ${heading}`] : []),
    ...(block.addedAt
      ? [`Added date marker: <!-- added ${block.addedAt} -->`]
      : []),
    "Original Markdown:",
    block.originalText,
  ].join("\n");
  const observedAt = block.addedAt
    ? `${block.addedAt}T00:00:00.000Z`
    : source.observedAt;
  return {
    id: `legacy-memory-record:${stableId(
      source.sourceKey,
      sourceRevision,
      String(block.ordinal),
      block.originalText,
    )}`,
    scope: source.scope,
    kind: inferMemoryKind(block),
    statement: block.statement,
    conflictKey: `legacy-memory:${stableId(
      source.sourceKey,
      block.headingPath.join("\0"),
      String(block.headingOrdinal),
    )}`,
    confidence: 0.6,
    provenance: {
      source: "import",
      observedAt,
      evidence,
    },
  };
}

function inferMemoryKind(block: LegacyMemoryBlock): MemoryKind {
  const heading = block.headingPath.join(" ").toLowerCase();
  const context = `${heading} ${block.statement}`.toLowerCase();
  if (/\b(preference|preferences|style)\b/.test(heading)) return "preference";
  if (/\b(gotcha|gotchas|warning|warnings|pitfall|pitfalls)\b/.test(heading)) {
    return "gotcha";
  }
  if (/\b(decision|decisions|architecture)\b/.test(heading)) return "decision";
  if (/\b(correction|corrections)\b/.test(heading)) return "correction";
  if (/\b(workflow|workflows|process|checklist)\b/.test(heading)) {
    return "workflow_hint";
  }
  if (/\b(preference|prefer|style)\b/.test(context)) return "preference";
  if (/\b(gotcha|warning|pitfall|caution)\b/.test(context)) return "gotcha";
  if (/\b(decision|decided|architecture)\b/.test(context)) return "decision";
  if (/\b(correction|corrected|instead)\b/.test(context)) return "correction";
  if (/\b(workflow|process|checklist|steps?)\b/.test(context)) {
    return "workflow_hint";
  }
  return "project_fact";
}

function normalizeBlockStatement(originalText: string): string {
  return originalText
    .replace(/^\s*(?:[-*+] |\d+[.)] )/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAddedDate(value: string, lineNumber: number): string {
  const date = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Malformed legacy memory added date at line ${lineNumber}`);
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`Invalid legacy memory added date at line ${lineNumber}`);
  }
  return date;
}

function groupDigest(value: string): string {
  return value.match(/.{1,8}/g)?.join("-") ?? value;
}

function stableId(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex").slice(0, 32);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}
