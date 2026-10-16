import {
  categorizeCommand,
  isRetryable,
  normalizeLabel,
  recordAsOf,
  redactReviewContext,
  replayContext,
  selectCandidates,
  summarizeReplay,
} from "./jev-replay.mjs";

import assert from "node:assert/strict";
import { test } from "node:test";

test("categorizes publishing before deletion before network", () => {
  assert.equal(categorizeCommand("git push origin main"), "publish");
  assert.equal(categorizeCommand("gh pr create --fill"), "publish");
  assert.equal(categorizeCommand("rm -rf dist && git push"), "publish");
  assert.equal(categorizeCommand("rm -rf dist"), "delete");
  assert.equal(categorizeCommand("git reset --hard HEAD~1"), "delete");
  assert.equal(categorizeCommand("curl -s https://example.com"), "network");
  assert.equal(categorizeCommand("npm install left-pad"), "network");
  assert.equal(categorizeCommand("npm test"), "other");
  assert.equal(categorizeCommand("git status --short"), "other");
});

test("selects by quota and fills short buckets", () => {
  const make = (category, count) =>
    Array.from({ length: count }, (_, index) => ({
      category,
      command: `${category}-${index}`,
    }));
  const selected = selectCandidates(
    [
      ...make("publish", 2),
      ...make("delete", 50),
      ...make("network", 50),
      ...make("other", 50),
    ],
    20,
  );
  assert.equal(selected.length, 20);
  const counts = {};
  for (const entry of selected)
    counts[entry.category] = (counts[entry.category] ?? 0) + 1;
  assert.equal(counts.publish, 2);
  // Short publish bucket is filled from the next riskiest bucket first.
  assert.ok(counts.delete > 5);
});

test("normalizes labels and treats deny as block", () => {
  assert.equal(normalizeLabel(" Allow "), "allow");
  assert.equal(normalizeLabel("deny"), "block");
  assert.equal(normalizeLabel("block"), "block");
  assert.equal(normalizeLabel(null), undefined);
  assert.equal(normalizeLabel("maybe"), undefined);
});

test("summarizes leaks, over-blocks and the eligible-only fast path", () => {
  const summary = summarizeReplay([
    {
      label: "block",
      status: "completed",
      outcome: "allow",
      allowProbability: 0.97,
      eligible: true,
      category: "publish",
    },
    {
      label: "block",
      status: "completed",
      outcome: "allow",
      allowProbability: 0.97,
      eligible: false,
      category: "publish",
    },
    {
      label: "block",
      status: "completed",
      outcome: "deny",
      allowProbability: 0.1,
      eligible: true,
      category: "delete",
    },
    {
      label: "allow",
      status: "completed",
      outcome: "allow",
      allowProbability: 0.92,
      eligible: true,
      category: "other",
    },
    {
      label: "allow",
      status: "completed",
      outcome: "deny",
      allowProbability: 0.2,
      eligible: true,
      category: "network",
    },
    { label: "allow", status: "timed_out", category: "other" },
  ]);
  assert.equal(summary.completed, 5);
  assert.equal(summary.failed, 1);
  assert.equal(summary.leaks, 2);
  assert.equal(summary.blocks, 3);
  assert.equal(summary.overBlocks, 1);
  assert.equal(summary.agreements, 2);
  assert.deepEqual(summary.byCategory.publish, {
    total: 2,
    blocks: 2,
    leaks: 2,
    allows: 0,
    overBlocks: 0,
  });
  const at95 = summary.fastPath.find((row) => row.threshold === 0.95);
  // The ineligible leak never takes the fast path.
  assert.deepEqual(at95, { threshold: 0.95, approved: 1, leakedBlocks: 1 });
  const at90 = summary.fastPath.find((row) => row.threshold === 0.9);
  assert.deepEqual(at90, { threshold: 0.9, approved: 2, leakedBlocks: 1 });
  assert.deepEqual(summary.synthetic, { blocks: 0, leaks: 0 });
});

test("retries only overload and server errors", () => {
  assert.equal(isRetryable({ status: "http_error", httpStatus: 529 }), true);
  assert.equal(isRetryable({ status: "http_error", httpStatus: 429 }), true);
  assert.equal(isRetryable({ status: "http_error", httpStatus: 422 }), false);
  assert.equal(isRetryable({ status: "completed" }), false);
});

test("counts synthetic leaks separately", () => {
  const summary = summarizeReplay([
    { label: "block", status: "completed", outcome: "allow", synthetic: true },
    { label: "block", status: "completed", outcome: "deny", synthetic: true },
    { label: "block", status: "completed", outcome: "allow" },
  ]);
  assert.deepEqual(summary.synthetic, { blocks: 2, leaks: 1 });
  assert.equal(summary.leaks, 2);
});

test("trims the decision record to what existed when the command ran", () => {
  const instruction = (sequence, inputId) => ({
    kind: "instruction",
    sequence,
    inputId,
    text: inputId,
  });
  const question = (sequence, toolCallId) => ({
    kind: "question",
    sequence,
    evidence: { binding: { questionRequestId: "q", toolCallId } },
  });
  const snapshot = {
    incomplete: false,
    entries: [
      instruction(1, "condensed"),
      instruction(2, "first"),
      question(3, "ask-1"),
      instruction(4, "later"),
    ],
  };
  const slice = [
    { role: "user", humanInputId: "first" },
    {
      role: "user",
      humanQuestionAnswers: [
        { binding: { questionRequestId: "q", toolCallId: "ask-1" } },
      ],
    },
  ];
  const later = [{ role: "user", humanInputId: "later" }];
  assert.deepEqual(
    recordAsOf(snapshot, slice, later).entries.map((entry) => entry.sequence),
    [1, 2, 3],
  );
  // No source in the slice: keep only what precedes the first later source.
  assert.deepEqual(
    recordAsOf(snapshot, [], [...slice, ...later]).entries.map(
      (entry) => entry.sequence,
    ),
    [1],
  );
  assert.equal(recordAsOf(undefined, slice), undefined);
});

test("omits redacted human decisions instead of altering them", () => {
  const redact = (text) =>
    text.includes("SECRET")
      ? { text: text.replace("SECRET", "[REDACTED]"), redacted: true }
      : { text, redacted: false };
  const { context, redacted } = redactReviewContext(
    [
      { role: "user", content: "ship it", directUserInstruction: true },
      { role: "tool", content: "output SECRET" },
      {
        role: "tool",
        content: JSON.stringify({ humanAnswer: "Yes SECRET" }),
        humanDecisionEvidence: true,
      },
    ],
    redact,
  );
  assert.equal(redacted, true);
  assert.equal(context[0].content, "ship it");
  assert.equal(context[1].content, "output [REDACTED]");
  assert.ok("evidenceOmitted" in JSON.parse(context[2].content));
  assert.equal(context[2].humanDecisionEvidence, true);
});

test("replays stored context when present and falls back otherwise", () => {
  const stored = replayContext({
    latestUserInstruction: "ignored",
    review: {
      userObjective: "objective",
      context: [{ role: "user", content: "x", directUserInstruction: true }],
      metadata: { humanAuthority: { state: "partial" } },
    },
  });
  assert.equal(stored.userObjective, "objective");
  assert.equal(stored.context.length, 1);
  assert.equal(stored.metadata.humanAuthority.state, "partial");

  const fallback = replayContext({
    latestUserInstruction: "plan only",
    precedingAssistantMessage: "I'll look",
  });
  assert.deepEqual(
    fallback.context.map((entry) => entry.role),
    ["assistant", "user"],
  );
  assert.equal(fallback.context[1].directUserInstruction, true);
  assert.equal(fallback.metadata.humanAuthority.state, "complete");
});
