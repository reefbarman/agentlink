import type { AgentMessage } from "../types.js";

export const BUDGET_EVIDENCE_DIGEST_MARKER =
  "[budget_exhausted evidence digest]";
const MAX_DIGEST_ENTRIES = 40;
const MAX_FIELD_CHARS = 160;
/** Inputs that identify what was inspected; result content is never included. */
const EVIDENCE_INPUT_FIELDS = [
  "path",
  "paths",
  "file",
  "regex",
  "query",
  "pattern",
  "anchor",
  "offset",
  "symbol",
  "url",
  "server",
  "tool",
  "name",
] as const;

function boundedValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = Array.isArray(value)
    ? value.map((item) => String(item)).join(", ")
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) return undefined;
  return singleLine.length > MAX_FIELD_CHARS
    ? `${singleLine.slice(0, MAX_FIELD_CHARS - 1)}…`
    : singleLine;
}

function describeToolCall(name: string, input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return name;
  const record = input as Record<string, unknown>;
  const fields = EVIDENCE_INPUT_FIELDS.flatMap((field) => {
    const value = boundedValue(record[field]);
    return value ? [`${field}=${value}`] : [];
  });
  return fields.length ? `${name} ${fields.join(" ")}` : name;
}

/**
 * Build a bounded digest of the tool calls a background agent completed before
 * a hard budget stop. The stop can land before the agent summarizes, leaving
 * only opening narration; the digest tells the parent which sources were
 * already inspected so it does not have to rediscover them. Only identifying
 * inputs are listed; tool results are deliberately excluded.
 */
export function buildBudgetEvidenceDigest(
  messages: readonly AgentMessage[],
): string | undefined {
  const completed = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_result" && !block.is_error) {
        completed.add(block.tool_use_id);
      }
    }
  }

  const entries: string[] = [];
  let total = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type !== "tool_use" || !completed.has(block.id)) continue;
      total += 1;
      if (entries.length < MAX_DIGEST_ENTRIES) {
        entries.push(`- ${describeToolCall(block.name, block.input)}`);
      }
    }
  }
  if (entries.length === 0) return undefined;

  const omitted = total - entries.length;
  return [
    `${BUDGET_EVIDENCE_DIGEST_MARKER} The hard budget backstop stopped this agent before it summarized its findings. Completed tool calls (identifying inputs only; results are not included):`,
    ...entries,
    ...(omitted > 0 ? [`- …and ${omitted} more completed tool calls`] : []),
  ].join("\n");
}
