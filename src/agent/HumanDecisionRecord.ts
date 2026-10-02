import {
  collectHumanQuestionAnswer,
  type HumanQuestionAnswer,
} from "@agentlink/protocol/structured-question";

import type { AgentMessage } from "./types.js";

/** Oldest entries are dropped beyond this bound and the record is marked incomplete. */
export const MAX_HUMAN_DECISION_RECORD_ENTRIES = 200;
/** Recorded instruction text is bounded so its review evidence stays intact. */
export const MAX_RECORDED_INSTRUCTION_LENGTH = 1_800;

export type HumanDecisionRecordEntry =
  | {
      kind: "instruction";
      sequence: number;
      recordedAt: number;
      /** Matches `AgentMessage.humanInputId` on the source transcript message. */
      inputId: string;
      text: string;
      truncated?: true;
    }
  | {
      kind: "question";
      sequence: number;
      recordedAt: number;
      evidence: HumanQuestionAnswer;
    };

export interface HumanDecisionRecordSnapshot {
  entries: readonly HumanDecisionRecordEntry[];
  /** Some earlier verified human input is no longer in the record. */
  incomplete: boolean;
}

/** Session-metadata form. Bound to one session ID and never part of transcript JSON. */
export interface PersistedHumanDecisionRecord {
  schemaVersion: 1;
  sessionId: string;
  nextSequence: number;
  incomplete?: true;
  entries: HumanDecisionRecordEntry[];
}

/**
 * Private, ordered record of host-verified human input for one session.
 *
 * Only the host adds entries: typed messages from the VS Code or browser
 * composer and validated structured-question answers. It is persisted in
 * session metadata, survives condensation, and is pruned only when its source
 * messages are removed (for example by rewind). Forks, handoffs, `/btw` and
 * imported transcripts start with an empty record, so authority never travels
 * with copied history.
 */
export class HumanDecisionRecord {
  private entries: HumanDecisionRecordEntry[] = [];
  private nextSequence = 1;
  private incomplete = false;

  recordInstruction(inputId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const truncated = trimmed.length > MAX_RECORDED_INSTRUCTION_LENGTH;
    this.push({
      kind: "instruction",
      sequence: this.nextSequence++,
      recordedAt: Date.now(),
      inputId,
      text: truncated ? boundInstruction(trimmed) : trimmed,
      ...(truncated ? { truncated: true as const } : {}),
    });
  }

  recordQuestion(evidence: HumanQuestionAnswer): void {
    this.push({
      kind: "question",
      sequence: this.nextSequence++,
      recordedAt: Date.now(),
      evidence: structuredClone(evidence),
    });
  }

  /** Drop entries whose source message is no longer in the history. */
  prune(messages: readonly AgentMessage[]): void {
    if (!this.entries.length) return;
    const inputIds = new Set<string>();
    const questionKeys = new Set<string>();
    for (const message of messages) {
      if (message.humanInputId) inputIds.add(message.humanInputId);
      for (const evidence of message.humanQuestionAnswers ?? []) {
        questionKeys.add(questionKey(evidence));
      }
    }
    this.entries = this.entries.filter((entry) =>
      entry.kind === "instruction"
        ? inputIds.has(entry.inputId)
        : questionKeys.has(questionKey(entry.evidence)),
    );
  }

  snapshot(): HumanDecisionRecordSnapshot {
    return {
      entries: this.entries.map((entry) => structuredClone(entry)),
      incomplete: this.incomplete,
    };
  }

  toPersisted(sessionId: string): PersistedHumanDecisionRecord | undefined {
    if (!this.entries.length && !this.incomplete) return undefined;
    return {
      schemaVersion: 1,
      sessionId,
      nextSequence: this.nextSequence,
      ...(this.incomplete ? { incomplete: true as const } : {}),
      entries: this.entries.map((entry) => structuredClone(entry)),
    };
  }

  /**
   * Restore a record persisted for exactly this session. Anything bound to a
   * different session, malformed, or with no surviving source is discarded.
   */
  static restore(
    sessionId: string,
    persisted: unknown,
    messages: readonly AgentMessage[],
  ): HumanDecisionRecord {
    const record = new HumanDecisionRecord();
    if (!persisted || typeof persisted !== "object") return record;
    const value = persisted as Partial<PersistedHumanDecisionRecord>;
    if (
      value.schemaVersion !== 1 ||
      value.sessionId !== sessionId ||
      !Array.isArray(value.entries)
    ) {
      return record;
    }
    let maxSequence = 0;
    for (const raw of value.entries) {
      const entry = validEntry(raw, sessionId);
      if (!entry) {
        record.incomplete = true;
        continue;
      }
      maxSequence = Math.max(maxSequence, entry.sequence);
      record.entries.push(entry);
    }
    record.entries.sort((a, b) => a.sequence - b.sequence);
    record.nextSequence = Math.max(
      maxSequence + 1,
      typeof value.nextSequence === "number" &&
        Number.isSafeInteger(value.nextSequence)
        ? value.nextSequence
        : 1,
    );
    record.incomplete ||= value.incomplete === true;
    record.prune(messages);
    return record;
  }

  private push(entry: HumanDecisionRecordEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_HUMAN_DECISION_RECORD_ENTRIES) {
      this.entries.splice(
        0,
        this.entries.length - MAX_HUMAN_DECISION_RECORD_ENTRIES,
      );
      this.incomplete = true;
    }
  }
}

function questionKey(evidence: HumanQuestionAnswer): string {
  return `${evidence.binding.questionRequestId}\u0000${evidence.binding.toolCallId}`;
}

function boundInstruction(text: string): string {
  const half = Math.floor((MAX_RECORDED_INSTRUCTION_LENGTH - 20) / 2);
  return `${text.slice(0, half)}\n… omitted …\n${text.slice(-half)}`;
}

function validEntry(
  raw: unknown,
  sessionId: string,
): HumanDecisionRecordEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as Record<string, unknown>;
  const sequence = entry.sequence;
  const recordedAt = entry.recordedAt;
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    typeof recordedAt !== "number"
  ) {
    return undefined;
  }
  if (entry.kind === "instruction") {
    const { inputId, text } = entry;
    if (
      typeof inputId !== "string" ||
      !inputId ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > MAX_RECORDED_INSTRUCTION_LENGTH
    ) {
      return undefined;
    }
    return {
      kind: "instruction",
      sequence,
      recordedAt,
      inputId,
      text,
      ...(entry.truncated === true ? { truncated: true as const } : {}),
    };
  }
  if (entry.kind !== "question") return undefined;
  const evidence = entry.evidence as Partial<HumanQuestionAnswer> | undefined;
  const binding = evidence?.binding;
  if (
    evidence?.source !== "human_ui" ||
    !binding ||
    binding.schemaVersion !== 1 ||
    binding.sessionId !== sessionId ||
    typeof binding.questionRequestId !== "string" ||
    !binding.questionRequestId ||
    typeof binding.toolCallId !== "string" ||
    !binding.toolCallId ||
    typeof binding.context !== "string" ||
    !Array.isArray(binding.questions) ||
    !evidence.answers ||
    typeof evidence.answers !== "object" ||
    !evidence.notes ||
    typeof evidence.notes !== "object"
  ) {
    return undefined;
  }
  // Re-derive through the host validator so only answers valid for the
  // literal recorded questions survive.
  let revalidated: HumanQuestionAnswer | undefined;
  try {
    revalidated = collectHumanQuestionAnswer(binding, {
      answers: evidence.answers,
      notes: evidence.notes,
    });
  } catch {
    return undefined;
  }
  return revalidated
    ? { kind: "question", sequence, recordedAt, evidence: revalidated }
    : undefined;
}
