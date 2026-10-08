import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, test } from "node:test";
import {
  buildIndicators,
  parseArgs,
  percentile,
  readSessionOutcomes,
  simulateGuardianShadowFastPath,
} from "./report-session-outcomes.mjs";

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "report-session-outcomes.mjs",
);

const tempDirectories = [];

function makeTempDirectory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentlink-session-outcomes-"),
  );
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function event(overrides) {
  return {
    version: 1,
    at: "2026-08-06T10:00:00.000Z",
    instanceId: "fixture",
    pid: 1,
    extensionVersion: "1.18.21",
    ...overrides,
  };
}

test("separates publication attempts from tagged prompt sources without inferring a rate", () => {
  const input = path.join(makeTempDirectory(), "events.jsonl");
  writeEvents(input, [
    event({
      type: "review_publication_attempt",
      sessionId: "s",
      stage: "guardian_attempt",
      scopeEvidence: "verified",
    }),
    event({
      type: "review_publication_attempt",
      sessionId: "s",
      stage: "guardian_attempt",
      scopeEvidence: "unavailable",
    }),
    event({
      type: "approval_interruption",
      reviewPublicationCommand: true,
      reason: "guardian_denied",
      guardianStatus: "reviewed",
    }),
    event({
      type: "approval_interruption",
      reviewPublicationCommand: true,
      reason: "prompt_rule",
    }),
    event({
      type: "approval_interruption",
      reason: "network_destination_approval",
    }),
  ]);
  assert.deepEqual(readSessionOutcomes(input).reviewPublication, {
    guardianAttempts: 2,
    scopeEvidence: { verified: 1, unavailable: 1 },
    prompts: 2,
    promptSources: { guardian_denied: 1, prompt_rule: 1 },
    promptsWithGuardianReview: 1,
  });
});

function efficiency(overrides = {}) {
  return {
    ordinaryAgentProviderAttempts: 2,
    condenseProviderAttempts: 1,
    completedApiTurns: 1,
    usageEstimatedApiTurns: 0,
    uncachedInputTokens: 20,
    cacheReadTokens: 70,
    cacheCreationTokens: 10,
    outputTokens: 5,
    cacheBreakdownApiTurns: 1,
    cacheBreakdownInputTokens: 100,
    cacheBreakdownReadTokens: 70,
    cacheBreakdownCreationTokens: 10,
    staticFloorSamples: 2,
    staticFloorTokenSends: 50,
    contextLedgerSamples: 2,
    boundedContextRequestedTokens: 10,
    boundedContextOmittedTokens: 5,
    requestsRequestingBoundedContext: 1,
    requestsWithContextOmission: 1,
    contextOverflowTokens: 0,
    requestsWithContextOverflow: 0,
    toolCalls: 4,
    ...overrides,
  };
}

function writeEvents(filePath, events) {
  fs.writeFileSync(
    filePath,
    events
      .map((entry) =>
        typeof entry === "string" ? entry : JSON.stringify(entry),
      )
      .join("\n") + "\n",
    "utf-8",
  );
}

test("uses matching opportunity costs and labels repeated context without claiming savings", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  const turn = (sessionId, opportunities, tokens, attempts, enabled = true) =>
    event({
      type: "turn_completed",
      sessionId,
      background: false,
      turnDurationMs: 100,
      composeEfficiency: {
        schemaVersion: 1,
        enabledRequestCount: enabled ? attempts : 0,
        composeOpportunityTurns: opportunities,
        directComposableHistoryTokens: tokens,
        composeHistoryTokens: 0,
        inlineDefinitionTokens: tokens / 10,
        providerAttempts: attempts,
        durationMs: 100,
        toolCalls: 4,
      },
    });
  writeEvents(inputPath, [
    turn("opportunity", 1, 100, 2),
    turn("not-opportunity", 0, 900, 3),
    turn("disabled", 1, 50, 1, false),
    event({ type: "background_lifecycle", sessionId: "bg-missing" }),
    event({
      type: "background_lifecycle",
      sessionId: "bg-false",
      steered: false,
    }),
    event({
      type: "background_lifecycle",
      sessionId: "bg-true",
      steered: true,
    }),
  ]);
  const report = readSessionOutcomes(inputPath);
  const normalized = report.composeEfficiency.normalized;
  assert.equal(normalized.enabled.instrumentedTurns, 2);
  assert.equal(normalized.enabled.perOpportunity.historyTokenSends, 100);
  assert.equal(normalized.enabled.perOpportunity.providerAttempts, 2);
  assert.equal(normalized.enabled.perRequest.historyTokenSends, 200);
  assert.equal(normalized.enabled.perRequest.definitionTokenSends, 20);
  assert.equal(normalized.netContextTokensSavedPerOpportunity, null);
  assert.equal(normalized.netContextSavingsRate, null);
  assert.equal(report.background.steeringObservedRecords, 2);
  assert.equal(report.background.steered, 1);
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--input", inputPath],
    { encoding: "utf-8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /observational cohorts; not causal savings/);
  assert.match(result.stdout, /estimated history token-sends/);
  assert.match(result.stdout, /steering records missing/);
  assert.doesNotMatch(
    result.stdout,
    /net-context-saved|retained result tokens/,
  );
});

test("aggregates turns, tasks, and background lifecycles into indicators", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  writeEvents(inputPath, [
    event({
      type: "turn_completed",
      sessionId: "s1",
      background: false,
      turnDurationMs: 600_000,
      streamingMs: 100_000,
      toolMs: 100_000,
      backgroundWaitMs: 200_000,
      userWaitMs: 100_000,
      toolCalls: 20,
      spawns: 2,
      reviewSpawns: 1,
      spawnedBeforeFirstAction: true,
      autoContinues: 1,
    }),
    event({
      type: "turn_completed",
      sessionId: "s1",
      background: false,
      turnDurationMs: 100_000,
      streamingMs: 50_000,
      toolMs: 40_000,
      toolCalls: 5,
    }),
    event({
      type: "task_completed",
      sessionId: "s1",
      background: false,
      status: "completed",
      taskDurationMs: 700_000,
      turns: 2,
    }),
    event({
      type: "task_completed",
      sessionId: "s2",
      background: false,
      status: "blocked",
      taskDurationMs: 50_000,
      turns: 1,
    }),
    event({
      type: "background_lifecycle",
      sessionId: "bg1",
      parentSessionId: "s1",
      taskClass: "review_code",
      terminal: "completed",
      queuedMs: 5_000,
      runMs: 240_000,
      parentBlockedMs: 120_000,
      reviewFindings: { high: 0, low: 0 },
      reviewEmptyDiff: false,
      backend: "native",
      reviewTargetKind: "working_tree",
      reviewHandoffBytes: 1_000,
      reviewInlineBytes: 0,
      usedToolCalls: 5,
      usedApiTurns: 3,
      reportedInputTokens: 2_000,
    }),
    event({
      type: "background_lifecycle",
      sessionId: "bg2",
      parentSessionId: "s1",
      taskClass: "readonly-research",
      terminal: "killed",
      runMs: 60_000,
      killed: true,
    }),
    event({
      type: "approval_interruption",
      sessionId: "s1",
      background: false,
      approvalKind: "command",
      reason: "guardian_denied",
      guardianStatus: "reviewed",
      risk: "high",
    }),
    event({
      type: "approval_interruption",
      sessionId: "bg1",
      background: true,
      approvalKind: "path",
      reason: "human_only",
    }),
    event({
      type: "guardian_shadow_comparison",
      sessionId: "s1",
      reviewKind: "command",
      shadowProvider: "typesafe",
      primaryStatus: "reviewed",
      primaryOutcome: "allow",
      primaryRisk: "low",
      primaryAuthorization: "medium",
      primaryDurationMs: 1_000,
      actionFamily: "opaque",
      authorizationEvidence: "complete",
      shadowStatus: "completed",
      shadowOutcome: "deny",
      shadowRisk: "high",
      shadowAuthorization: "low",
      shadowDecisionBasis: "authorization",
      shadowDurationMs: 200,
      outcomesAgree: false,
      shadowFaster: true,
      shadowInputRedacted: true,
      shadowEvidenceWithheld: true,
      shadowInputTokens: 300,
      shadowOutputTokens: 40,
    }),
    event({
      type: "guardian_shadow_comparison",
      sessionId: "s2",
      reviewKind: "command",
      shadowProvider: "typesafe",
      primaryStatus: "reviewed",
      primaryOutcome: "allow",
      primaryRisk: "low",
      primaryDurationMs: 500,
      shadowStatus: "timed_out",
      shadowDurationMs: 15_000,
    }),
    "not json",
    event({ type: "mystery_event", sessionId: "s9" }),
  ]);

  const report = readSessionOutcomes(inputPath);

  assert.equal(report.events, 11);
  assert.equal(report.invalidLines, 1);
  assert.equal(report.unknownEvents, 1);
  assert.equal(report.sessionCount, 3);

  assert.equal(report.turns.count, 2);
  assert.equal(report.turns.totalMs, 700_000);
  assert.equal(report.turns.backgroundWaitMs, 200_000);
  assert.equal(report.turns.spawns, 2);
  assert.equal(report.turns.turnsWithSpawns, 1);

  assert.equal(report.tasks.byStatus.completed, 1);
  assert.equal(report.tasks.byStatus.blocked, 1);

  assert.equal(report.background.count, 2);
  assert.equal(report.background.byTaskClass.review_code, 1);
  assert.equal(report.background.byTerminal.killed, 1);
  assert.equal(report.background.reviews, 1);
  // Zero findings on a non-empty diff counts as an empty review.
  assert.equal(report.background.emptyReviews, 1);
  assert.equal(report.background.smallScopeReviews, 1);
  assert.deepEqual(report.background.reviewByBackend, { native: 1 });
  assert.deepEqual(report.background.reviewByTargetKind, { working_tree: 1 });
  assert.deepEqual(report.background.reviewHandoffBytes, [1_000]);
  assert.deepEqual(report.background.reviewInlineBytes, [0]);
  assert.deepEqual(report.background.reviewToolCalls, [5]);
  assert.deepEqual(report.background.reviewApiTurns, [3]);
  assert.deepEqual(report.background.reviewInputTokens, [2_000]);

  assert.equal(report.approvalInterruptions.count, 2);
  assert.equal(report.approvalInterruptions.backgroundCount, 1);
  assert.deepEqual(report.approvalInterruptions.byKind, {
    command: 1,
    path: 1,
  });
  assert.deepEqual(report.approvalInterruptions.byReason, {
    guardian_denied: 1,
    human_only: 1,
  });
  assert.deepEqual(report.approvalInterruptions.byGuardianStatus, {
    reviewed: 1,
  });
  assert.equal(report.byVersion["1.18.21"].approvalInterruptions, 2);

  assert.equal(report.guardianShadow.count, 2);
  assert.equal(report.guardianShadow.completed, 1);
  assert.equal(report.guardianShadow.agreements, 0);
  assert.equal(report.guardianShadow.disagreements, 1);
  assert.equal(report.guardianShadow.comparableDurations, 1);
  assert.equal(report.guardianShadow.shadowFaster, 1);
  assert.equal(report.guardianShadow.redacted, 1);
  assert.equal(report.guardianShadow.evidenceWithheld, 1);
  assert.deepEqual(report.guardianShadow.byStatus, {
    completed: 1,
    timed_out: 1,
  });
  assert.deepEqual(report.guardianShadow.primaryDurationsMs, [1_000]);
  assert.deepEqual(report.guardianShadow.shadowDurationsMs, [200]);
  assert.equal(report.guardianShadow.inputTokens, 300);
  assert.equal(report.guardianShadow.outputTokens, 40);
  assert.deepEqual(report.guardianShadow.byOutcomePair, { "allow/deny": 1 });
  assert.equal(report.guardianShadow.denyAllow.count, 0);
  assert.deepEqual(report.guardianShadow.allowDeny, {
    count: 1,
    redacted: 1,
    evidenceWithheld: 1,
    byActionFamily: { opaque: 1 },
    byPrimaryRisk: { low: 1 },
    byShadowRisk: { high: 1 },
    byPrimaryAuthorization: { medium: 1 },
    byShadowAuthorization: { low: 1 },
    byDecisionBasis: { authorization: 1 },
    byAuthorizationEvidence: { complete: 1 },
  });

  const indicators = report.indicators;
  // Active time = 700k - 100k user wait; 200k blocked on background.
  assert.ok(Math.abs(indicators.blockedWaitRatio - 200_000 / 600_000) < 1e-9);
  assert.equal(indicators.spawnsPerTurn, 1);
  assert.equal(indicators.spawnBeforeFirstActionRate, 1);
  assert.equal(indicators.emptyReviewRate, 1);
  assert.equal(indicators.smallScopeReviewRate, 1);
  assert.equal(indicators.killedRate, 0.5);
  assert.equal(indicators.taskCompletionRate, 0.5);
  assert.equal(indicators.completedTaskP50Ms, 700_000);
  assert.equal(indicators.autoContinuesPerTurn, 0.5);
});

test("labels missing TypeSafe diagnostic fields as unreported", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  writeEvents(inputPath, [
    event({
      type: "guardian_shadow_comparison",
      sessionId: "legacy",
      reviewKind: "command",
      shadowProvider: "typesafe",
      primaryStatus: "reviewed",
      primaryOutcome: "allow",
      primaryRisk: "low",
      primaryDurationMs: 500,
      shadowStatus: "completed",
      shadowOutcome: "deny",
      shadowRisk: "high",
      shadowDurationMs: 200,
      outcomesAgree: false,
    }),
  ]);

  const report = readSessionOutcomes(inputPath);
  assert.deepEqual(report.guardianShadow.allowDeny, {
    count: 1,
    redacted: 0,
    evidenceWithheld: 0,
    byActionFamily: { unreported: 1 },
    byPrimaryRisk: { low: 1 },
    byShadowRisk: { high: 1 },
    byPrimaryAuthorization: { unreported: 1 },
    byShadowAuthorization: { unreported: 1 },
    byDecisionBasis: { unreported: 1 },
    byAuthorizationEvidence: { unreported: 1 },
  });
});

test("reports versioned comparison cohorts without merging outcomes across variants", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  const observation = (overrides = {}) => ({
    policyVersion: "policy-v1",
    policyFingerprint: "fingerprint-a",
    adapterVersion: "adapter-a",
    requestedModel: "model-requested",
    reportedModel: "model-reported",
    modelProvenance: "reported",
    attempts: 1,
    projection: { kind: "jev_shadow" },
    ...overrides,
  });
  const comparison = (primaryOutcome, shadowOutcome, extra = {}) =>
    event({
      type: "guardian_shadow_comparison",
      sessionId: "s1",
      primaryOutcome,
      shadowOutcome,
      primaryStatus: "reviewed",
      shadowStatus: "completed",
      shadowAllowProbabilityPermille: 999,
      shadowRiskProbabilitiesPermille: { high: 0, critical: 0 },
      comparisonVersion: 2,
      comparison: {
        snapshotId: "snapshot",
        policyEqual: true,
        evidenceEqual: true,
        evidenceComplete: true,
        primary: observation({
          usage: { inputTokens: 0, coverage: "reported" },
        }),
        shadow: observation({
          policyFingerprint: "fingerprint-b",
          adapterVersion: "adapter-b",
          projection: { kind: "primary_legacy" },
          usage: { outputTokens: 25, coverage: "partial" },
        }),
      },
      ...extra,
    });
  writeEvents(inputPath, [
    comparison("deny", "allow"),
    comparison("allow", "deny"),
    event({
      type: "guardian_shadow_comparison",
      sessionId: "legacy",
      primaryOutcome: "deny",
      shadowOutcome: "allow",
      primaryStatus: "reviewed",
      shadowStatus: "completed",
    }),
  ]);

  const report = readSessionOutcomes(inputPath);
  assert.equal(report.guardianComparison.count, 2);
  assert.deepEqual(report.guardianComparison.byClass, {
    equal_policy_equal_evidence_complete: 2,
  });
  assert.equal(Object.keys(report.guardianComparison.cohorts).length, 1);
  const [cohort] = Object.values(report.guardianComparison.cohorts);
  assert.deepEqual(cohort.byOutcomeDirection, {
    "deny/allow": 1,
    "allow/deny": 1,
  });
  assert.equal(cohort.usageInputSamples, 2);
  assert.equal(cohort.usageInputTokens, 0);
  assert.equal(cohort.usageOutputSamples, 2);
  assert.equal(cohort.usageOutputTokens, 50);
  assert.equal(cohort.usageMissingObservations, 0);
  assert.equal(report.guardianShadow.fastPathSamples.length, 0);
  assert.equal(report.guardianShadow.byOutcomePair["deny/allow"], 1);
  assert.deepEqual(report.guardianComparison.byOutcomeDirection, {});
});

test("simulates TypeSafe fast-path thresholds against Guardian decisions", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  const comparison = (primaryOutcome, allowPermille, highRisk) =>
    event({
      type: "guardian_shadow_comparison",
      sessionId: "s1",
      reviewKind: "command",
      shadowProvider: "typesafe",
      primaryStatus: "reviewed",
      primaryOutcome,
      primaryRisk: "medium",
      primaryDurationMs: 3_000,
      shadowStatus: "completed",
      shadowOutcome: allowPermille >= 500 ? "allow" : "deny",
      shadowRisk: "low",
      shadowDurationMs: 300,
      outcomesAgree: (primaryOutcome === "allow") === allowPermille >= 500,
      shadowAllowProbabilityPermille: allowPermille,
      ...(highRisk === undefined
        ? {}
        : {
            shadowRiskProbabilitiesPermille: {
              low: 1_000 - highRisk,
              medium: 0,
              high: highRisk,
              critical: 0,
            },
          }),
    });
  writeEvents(inputPath, [
    comparison("allow", 950, 20),
    comparison("allow", 820, 40),
    comparison("allow", 300, 50),
    comparison("deny", 910, 400),
    comparison("deny", 650, undefined),
  ]);

  const report = readSessionOutcomes(inputPath);
  assert.equal(report.guardianShadow.fastPathSamples.length, 5);
  const simulation = simulateGuardianShadowFastPath(
    report.guardianShadow.fastPathSamples,
  );
  assert.equal(simulation.samples, 5);
  assert.equal(simulation.denials, 2);
  assert.equal(simulation.riskScoredSamples, 4);
  const at = (threshold) =>
    simulation.rows.find((row) => row.allowThresholdPermille === threshold);
  assert.deepEqual(at(600).allowOnly, {
    fastPath: 4,
    fastPathShare: 0.8,
    leakedDenials: 2,
    leakedDenialShare: 1,
  });
  assert.deepEqual(at(900).allowOnly, {
    fastPath: 2,
    fastPathShare: 0.4,
    leakedDenials: 1,
    leakedDenialShare: 0.5,
  });
  assert.deepEqual(at(600).allowAndLowHighRisk, {
    fastPath: 2,
    fastPathShare: 0.5,
    leakedDenials: 0,
    leakedDenialShare: 0,
  });
});

test("breaks down Guardian deny -> TypeSafe allow disagreements", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  const comparison = (primaryOutcome, shadowOutcome, extra = {}) =>
    event({
      type: "guardian_shadow_comparison",
      sessionId: "s1",
      reviewKind: "command",
      shadowProvider: "typesafe",
      primaryStatus: "reviewed",
      primaryOutcome,
      primaryRisk: "medium",
      primaryAuthorization: "low",
      primaryDurationMs: 3_000,
      shadowStatus: "completed",
      shadowOutcome,
      shadowRisk: "high",
      shadowAuthorization: "low",
      shadowDecisionBasis: "authorized",
      shadowDurationMs: 300,
      outcomesAgree: primaryOutcome === shadowOutcome,
      ...extra,
    });
  writeEvents(inputPath, [
    comparison("deny", "allow", {
      actionFamily: "external",
      authorizationEvidence: "complete",
      shadowInputRedacted: true,
    }),
    comparison("deny", "deny"),
    comparison("allow", "allow"),
  ]);

  const report = readSessionOutcomes(inputPath);
  assert.deepEqual(report.guardianShadow.byOutcomePair, {
    "deny/allow": 1,
    "deny/deny": 1,
    "allow/allow": 1,
  });
  assert.equal(report.guardianShadow.allowDeny.count, 0);
  assert.deepEqual(report.guardianShadow.denyAllow, {
    count: 1,
    redacted: 1,
    evidenceWithheld: 0,
    byActionFamily: { external: 1 },
    byPrimaryRisk: { medium: 1 },
    byShadowRisk: { high: 1 },
    byPrimaryAuthorization: { low: 1 },
    byShadowAuthorization: { low: 1 },
    byDecisionBasis: { authorized: 1 },
    byAuthorizationEvidence: { complete: 1 },
  });
});

test("reports cache and self-reported completion efficiency with coverage", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  writeEvents(inputPath, [
    event({
      type: "turn_completed",
      sessionId: "s1",
      background: false,
      model: "model-a",
      runtimeKind: "builtin",
      turnDurationMs: 1_000,
      efficiency: efficiency(),
    }),
    event({
      type: "task_completed",
      sessionId: "s1",
      background: false,
      model: "model-a",
      runtimeKind: "builtin",
      status: "completed",
      taskDurationMs: 2_000,
      agentActiveMs: 1_500,
      mixedProviderOrModel: false,
      efficiency: efficiency(),
    }),
    event({
      type: "task_completed",
      sessionId: "legacy",
      background: false,
      status: "completed",
      taskDurationMs: 3_000,
    }),
    event({
      type: "task_completed",
      sessionId: "builtin-missing",
      background: false,
      runtimeKind: "builtin",
      status: "completed",
      taskDurationMs: 3_500,
    }),
    event({
      type: "task_completed",
      sessionId: "unknown-runtime",
      background: false,
      runtimeKind: "unknown",
      status: "completed",
      taskDurationMs: 3_750,
    }),
    event({
      type: "task_completed",
      sessionId: "acp",
      background: true,
      runtimeKind: "acp",
      status: "completed",
      taskDurationMs: 4_000,
    }),
  ]);

  const report = readSessionOutcomes(inputPath);
  assert.equal(report.cacheEfficiency.cacheReadShare, 0.7);
  assert.equal(report.cacheEfficiency.cacheBreakdownCoverage, 1);
  assert.equal(report.cacheEfficiency.ordinaryAgentProviderAttempts, 2);
  assert.equal(report.cacheEfficiency.condenseProviderAttempts, 1);
  assert.equal(report.completionEfficiency.samples, 1);
  assert.equal(report.completionEfficiency.legacyMissing, 1);
  assert.equal(report.completionEfficiency.builtinMissingEfficiency, 1);
  assert.equal(report.completionEfficiency.unknownRuntimeMissingEfficiency, 1);
  assert.equal(report.completionEfficiency.unsupportedRuntime, 1);
  assert.deepEqual(report.completionEfficiency.byRuntimeKind, {
    builtin: 2,
    "legacy-missing": 1,
    unknown: 1,
    acp: 1,
  });
  assert.deepEqual(report.completionEfficiency.elapsedMs, [2_000]);
  assert.deepEqual(report.completionEfficiency.agentActiveMs, [1_500]);
  assert.equal(report.completionEfficiency.efficiency.cacheReadShare, 0.7);
  assert.equal(report.byVersion["1.18.21"].completionEfficiencySamples, 1);
  assert.equal(report.byVersion["1.18.21"].completionUncachedInputTokens, 20);
});

test("keeps cache share unavailable when no input partition is reported", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  writeEvents(inputPath, [
    event({
      type: "turn_completed",
      sessionId: "s1",
      background: false,
      turnDurationMs: 1,
      efficiency: efficiency({
        cacheBreakdownApiTurns: 0,
        cacheBreakdownInputTokens: 0,
        cacheBreakdownReadTokens: 0,
        cacheBreakdownCreationTokens: 0,
      }),
    }),
  ]);

  const report = readSessionOutcomes(inputPath);
  assert.equal(report.cacheEfficiency.cacheReadShare, undefined);
  assert.equal(report.cacheEfficiency.cacheBreakdownCoverage, 0);
});

test("aggregates provider transport and fallback API turns", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  writeEvents(inputPath, [
    event({
      type: "turn_completed",
      sessionId: "s1",
      background: false,
      turnDurationMs: 1,
      efficiency: efficiency({
        websocketApiTurns: 3,
        httpApiTurns: 1,
        transportFallbackApiTurns: 1,
      }),
    }),
    event({
      type: "turn_completed",
      sessionId: "legacy",
      background: false,
      turnDurationMs: 1,
      efficiency: efficiency(),
    }),
  ]);

  const report = readSessionOutcomes(inputPath);
  assert.equal(report.cacheEfficiency.websocketApiTurns, 3);
  assert.equal(report.cacheEfficiency.httpApiTurns, 1);
  assert.equal(report.cacheEfficiency.transportFallbackApiTurns, 1);
});

test("does not count array-shaped efficiency payloads as snapshots", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  writeEvents(inputPath, [
    event({
      type: "turn_completed",
      sessionId: "malformed",
      background: false,
      turnDurationMs: 1,
      efficiency: [],
    }),
  ]);

  const report = readSessionOutcomes(inputPath);
  assert.equal(report.cacheEfficiency.snapshots, 0);
});

test("emptyDiff reviews are not counted as empty reviews", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  writeEvents(inputPath, [
    event({
      type: "background_lifecycle",
      sessionId: "bg1",
      taskClass: "review_code",
      terminal: "completed",
      reviewFindings: {},
      reviewEmptyDiff: true,
    }),
  ]);
  const report = readSessionOutcomes(inputPath);
  assert.equal(report.background.reviews, 1);
  assert.equal(report.background.emptyReviews, 0);
});

test("filters by date range and extension version", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  writeEvents(inputPath, [
    event({
      type: "turn_completed",
      sessionId: "old",
      background: false,
      at: "2026-08-01T00:00:00.000Z",
      turnDurationMs: 1,
    }),
    event({
      type: "turn_completed",
      sessionId: "new",
      background: false,
      at: "2026-08-06T00:00:00.000Z",
      turnDurationMs: 2,
    }),
    event({
      type: "turn_completed",
      sessionId: "other-version",
      background: false,
      at: "2026-08-06T00:00:00.000Z",
      extensionVersion: "1.18.10",
      turnDurationMs: 4,
    }),
  ]);

  const since = readSessionOutcomes(inputPath, {
    since: new Date("2026-08-05T00:00:00.000Z"),
  });
  assert.equal(since.turns.count, 2);

  const versioned = readSessionOutcomes(inputPath, {
    versions: ["1.18.10"],
  });
  assert.equal(versioned.turns.count, 1);
  assert.equal(versioned.turns.totalMs, 4);
});

test("parseArgs handles filters and rejects unknown flags", () => {
  const args = parseArgs(
    [
      "--since",
      "2026-08-01",
      "--until",
      "2026-08-06",
      "--version",
      "1.18.21",
      "--top",
      "5",
    ],
    new Date("2026-08-06T12:00:00.000Z"),
  );
  assert.equal(args.since.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(args.until.toISOString(), "2026-08-06T23:59:59.999Z");
  assert.deepEqual(args.versions, ["1.18.21"]);
  assert.equal(args.top, 5);

  const relative = parseArgs(
    ["--since", "2d"],
    new Date("2026-08-06T12:00:00.000Z"),
  );
  assert.equal(relative.since.toISOString(), "2026-08-04T12:00:00.000Z");

  assert.throws(() => parseArgs(["--bogus"]));
  assert.throws(() => parseArgs(["--since"]));
});

test("percentile handles empty and single-element inputs", () => {
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([7], 0.9), 7);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4], 0.9), 4);
});

test("indicators tolerate an empty report", () => {
  const directory = makeTempDirectory();
  const report = readSessionOutcomes(path.join(directory, "missing.jsonl"));
  const indicators = buildIndicators(report);
  assert.equal(indicators.blockedWaitRatio, 0);
  assert.equal(indicators.taskCompletionRate, 0);
  assert.equal(indicators.completedTaskP50Ms, 0);
});

test("CLI prints a summary and writes JSON", () => {
  const directory = makeTempDirectory();
  const inputPath = path.join(directory, "events.jsonl");
  const jsonPath = path.join(directory, "out", "report.json");
  writeEvents(inputPath, [
    event({
      type: "turn_completed",
      sessionId: "s1",
      background: false,
      turnDurationMs: 60_000,
      backgroundWaitMs: 30_000,
    }),
    event({
      type: "approval_interruption",
      sessionId: "s1",
      background: false,
      approvalKind: "command",
      reason: "guardian_denied",
    }),
  ]);

  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--input", inputPath, "--json", jsonPath],
    { encoding: "utf-8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session Outcome Telemetry/);
  assert.match(result.stdout, /Sanity indicators/);
  assert.match(result.stdout, /blocked-wait ratio/);
  assert.match(result.stdout, /Approve for Me interruptions/);
  assert.match(result.stdout, /guardian_denied:1/);
  const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  assert.equal(parsed.turns.count, 1);
});
