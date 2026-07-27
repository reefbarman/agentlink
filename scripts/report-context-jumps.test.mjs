import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, test } from "node:test";
import { readEvents, summarize } from "./report-context-jumps.mjs";

import assert from "node:assert/strict";

const tempDirectories = [];

function makeTempDirectory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentlink-context-report-"),
  );
  tempDirectories.push(directory);
  return directory;
}

function contextUsageEvent(event, recordedAt = "2026-07-25T00:00:00.000Z") {
  return {
    type: "context_usage_event",
    recordedAt,
    event,
  };
}

function writeJsonLines(filePath, records) {
  fs.writeFileSync(
    filePath,
    `${records
      .map((record) =>
        typeof record === "string" ? record : JSON.stringify(record),
      )
      .join("\n")}\n`,
    "utf8",
  );
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("summarizes dedicated request attribution without double-counting jump detail", () => {
  const inputPath = path.join(makeTempDirectory(), "context-usage.jsonl");
  const postCondenseEvents = Array.from({ length: 10 }, (_, index) =>
    contextUsageEvent({
      kind: "post_condense_first_request",
      sessionId: "session-1",
      model: "model-a",
      condenseEstimateTokens: 10_000,
      actualInputTokens: 10_001 + index,
      estimateGapTokens: index + 1,
    }),
  );
  writeJsonLines(inputPath, [
    "{partial",
    { type: "unrelated", event: { kind: "context_jump" } },
    contextUsageEvent({
      kind: "request_context_attribution",
      sessionId: "session-1",
      requestId: "request-1",
      requestKind: "agent",
      model: "model-a",
      estimatedInputTokens: 50_000,
      toolResultAttributions: [
        {
          toolCallId: "call-read-1",
          toolName: "read_file",
          chars: 400,
          bytes: 800,
          estimatedTokens: 100,
        },
        {
          toolCallId: "call-search-1",
          toolName: "search_files",
          chars: 200,
          bytes: 400,
          estimatedTokens: 50,
        },
      ],
      omittedToolResultAttributions: 2,
      pinnedMemoryTokens: 10,
      retrievedMemoryTokens: 20,
    }),
    contextUsageEvent({
      kind: "request_context_attribution",
      sessionId: "session-1",
      requestId: "request-2",
      requestKind: "condense",
      model: "model-a",
      estimatedInputTokens: 90_000,
      toolResultAttributions: [
        {
          toolCallId: "call-read-2",
          toolName: "read_file",
          chars: 100,
          bytes: 200,
          estimatedTokens: 25,
        },
      ],
      omittedToolResultAttributions: 1,
      pinnedMemoryTokens: 30,
      retrievedMemoryTokens: 40,
    }),
    contextUsageEvent({
      kind: "condense",
      sessionId: "session-1",
      model: "model-a",
      prevInputTokens: 100_000,
      newInputTokens: 10_000,
      reclaimedTokens: 90_000,
    }),
    ...postCondenseEvents,
    contextUsageEvent(
      {
        kind: "context_jump",
        sessionId: "session-1",
        model: "model-a",
        prevInputTokens: 50_000,
        inputTokens: 90_000,
        deltaTokens: 40_000,
        accumulatedBySource: {
          "tool:read_file": 20_000,
          "tool:search_files": 5_000,
        },
        systemPromptDeltaTokens: 1_000,
        toolDefinitionDeltaTokens: 2_000,
        prevAssistantOutputTokens: 3_000,
        unattributedTokens: 9_000,
        toolResultAttributions: [
          {
            toolCallId: "call-read-1",
            toolName: "read_file",
            chars: 400,
            bytes: 800,
            estimatedTokens: 100,
          },
        ],
      },
      "2026-07-25T00:01:00.000Z",
    ),
    contextUsageEvent({
      kind: "context_jump",
      sessionId: "session-1",
      model: "model-a",
      prevInputTokens: 90_000,
      inputTokens: 110_000,
      deltaTokens: 20_000,
      accumulatedBySource: { "tool:read_file": 10_000 },
    }),
  ]);

  const events = readEvents(inputPath);
  const summary = summarize(events, 1);

  assert.equal(events.length, 15);
  assert.equal(events.at(-2).recordedAt, "2026-07-25T00:01:00.000Z");
  assert.deepEqual(summary.totals, {
    events: 15,
    condenses: 1,
    postCondenseFirstRequests: 10,
    contextJumps: 2,
    requestContextAttributions: 2,
  });
  assert.deepEqual(summary.requestContextAttribution, {
    attributedToolResultCount: 3,
    attributedToolResultBytes: 1_400,
    attributedToolResultTokens: 175,
    omittedToolResultAttributions: 3,
    pinnedMemoryTokens: 40,
    retrievedMemoryTokens: 60,
    byTool: [
      { toolName: "read_file", count: 2, bytes: 1_000, estimatedTokens: 125 },
      { toolName: "search_files", count: 1, bytes: 400, estimatedTokens: 50 },
    ],
  });
  assert.deepEqual(summary.postCondenseEstimateGapTokens, {
    p50: 5,
    p90: 9,
    max: 10,
  });
  assert.deepEqual(summary.jumpTokensBySource, [
    ["tool:read_file", 30_000],
    ["unattributed", 9_000],
    ["tool:search_files", 5_000],
    ["assistant_output", 3_000],
    ["tool_definition_growth", 2_000],
    ["system_prompt_growth", 1_000],
  ]);
  assert.equal(summary.topJumps.length, 1);
  assert.equal(summary.topJumps[0].deltaTokens, 40_000);
  assert.equal(summary.topPostCondense.length, 1);
  assert.equal(summary.topPostCondense[0].estimateGapTokens, 10);
});
