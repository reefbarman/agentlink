import type { HumanQuestionAnswer } from "@agentlink/protocol/structured-question";
import { describe, expect, it } from "vitest";

import {
  HumanDecisionRecord,
  MAX_HUMAN_DECISION_RECORD_ENTRIES,
  MAX_RECORDED_INSTRUCTION_LENGTH,
} from "./HumanDecisionRecord.js";
import type { AgentMessage } from "./types.js";

function answer(sessionId = "session-1", toolCallId = "call-1") {
  return {
    source: "human_ui",
    binding: {
      schemaVersion: 1,
      sessionId,
      questionRequestId: `request-${toolCallId}`,
      toolCallId,
      context: "Release",
      questions: [{ id: "q", type: "yes_no", question: "Push to main?" }],
    },
    answers: { q: false },
    notes: {},
  } satisfies HumanQuestionAnswer;
}

function sources(): AgentMessage[] {
  return [
    { role: "user", content: "never force push", humanInputId: "input-1" },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }],
      humanQuestionAnswers: [answer()],
    },
  ];
}

function recorded(): HumanDecisionRecord {
  const record = new HumanDecisionRecord();
  record.recordInstruction("input-1", "never force push");
  record.recordQuestion(answer());
  return record;
}

describe("HumanDecisionRecord", () => {
  it("keeps verified input in order and prunes only removed sources", () => {
    const record = recorded();
    record.prune(sources());
    expect(record.snapshot().entries.map((entry) => entry.kind)).toEqual([
      "instruction",
      "question",
    ]);

    record.prune(sources().slice(0, 1));
    expect(record.snapshot()).toEqual({
      incomplete: false,
      entries: [expect.objectContaining({ kind: "instruction", sequence: 1 })],
    });
  });

  it("round-trips through persistence only for the same session", () => {
    const persisted = recorded().toPersisted("session-1");
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      sessionId: "session-1",
    });

    const restored = HumanDecisionRecord.restore(
      "session-1",
      structuredClone(persisted),
      sources(),
    );
    expect(restored.snapshot().entries).toHaveLength(2);
    restored.recordInstruction("input-3", "later");
    expect(restored.snapshot().entries.at(-1)?.sequence).toBe(3);

    expect(
      HumanDecisionRecord.restore(
        "other-session",
        persisted,
        sources(),
      ).snapshot().entries,
    ).toEqual([]);
  });

  it("drops restored entries that fail host validation and marks the record incomplete", () => {
    const persisted = recorded().toPersisted("session-1")!;
    const question = persisted.entries[1] as {
      evidence: { answers: Record<string, unknown> };
    };
    question.evidence.answers.q = "definitely";
    persisted.entries.push({
      kind: "question",
      sequence: 9,
      recordedAt: 1,
      evidence: answer("other-session"),
    });

    const restored = HumanDecisionRecord.restore(
      "session-1",
      persisted,
      sources(),
    ).snapshot();
    expect(restored.entries.map((entry) => entry.kind)).toEqual([
      "instruction",
    ]);
    expect(restored.incomplete).toBe(true);
  });

  it("bounds instructions and record length explicitly", () => {
    const record = new HumanDecisionRecord();
    record.recordInstruction("long", "x".repeat(5_000));
    const [entry] = record.snapshot().entries;
    expect(entry).toMatchObject({ kind: "instruction", truncated: true });
    expect(
      entry?.kind === "instruction" ? entry.text.length : Infinity,
    ).toBeLessThanOrEqual(MAX_RECORDED_INSTRUCTION_LENGTH);

    for (let index = 0; index < MAX_HUMAN_DECISION_RECORD_ENTRIES; index++) {
      record.recordInstruction(`input-${index}`, `instruction ${index}`);
    }
    const snapshot = record.snapshot();
    expect(snapshot.entries).toHaveLength(MAX_HUMAN_DECISION_RECORD_ENTRIES);
    expect(snapshot.incomplete).toBe(true);
    expect(snapshot.entries[0]).toMatchObject({ inputId: "input-0" });
  });

  it("persists nothing for an empty record", () => {
    expect(new HumanDecisionRecord().toPersisted("session-1")).toBeUndefined();
  });
});
