import { describe, expect, it } from "vitest";

import {
  evaluatePhase3MobilePaintGate,
  type Phase3MobilePaintCategory,
  type Phase3MobilePaintLatencyClass,
  type Phase3MobilePaintSample,
} from "./phase3MobilePaintGate.js";

const expectedClass: Readonly<
  Record<Phase3MobilePaintCategory, Phase3MobilePaintLatencyClass>
> = {
  text: "text_progress",
  progress: "text_progress",
  approval: "immediate",
  question: "immediate",
  error: "immediate",
  completion: "immediate",
};

function sample(
  category: Phase3MobilePaintCategory,
  ownerSequence: number,
  elapsedMs: number,
  overrides: Partial<Phase3MobilePaintSample> = {},
): Phase3MobilePaintSample {
  const sourceEventAt = 1_000 + ownerSequence * 1_000;
  return {
    correlationId: `correlation-${ownerSequence}`,
    eventId: `event-${ownerSequence}`,
    ownerId: "owner-1",
    ownerGenerationId: "generation-1",
    ownerSequence,
    eventKind: `event.${category}`,
    category,
    latencyClass: expectedClass[category],
    sourceEventAt,
    paintedAt: sourceEventAt + elapsedMs,
    elapsedMs,
    ...overrides,
  };
}

function representativeSamples(): readonly Phase3MobilePaintSample[] {
  return [
    sample("text", 1, 20),
    sample("progress", 2, 40),
    sample("approval", 3, 10),
    sample("question", 4, 30),
    sample("error", 5, 50),
    sample("completion", 6, 70),
  ];
}

describe("Phase 3 mobile paint gate", () => {
  it("passes representative samples and reports nearest-rank summaries", () => {
    const report = evaluatePhase3MobilePaintGate(representativeSamples());

    expect(report).toEqual({
      passed: true,
      violations: [],
      latencyByClass: {
        text_progress: { count: 2, p50Ms: 20, p95Ms: 40, maxMs: 40 },
        immediate: { count: 4, p50Ms: 30, p95Ms: 70, maxMs: 70 },
      },
      categoryCounts: {
        text: 1,
        progress: 1,
        approval: 1,
        question: 1,
        error: 1,
        completion: 1,
      },
    });
  });

  it("reports missing classes, categories, and configurable sample minima", () => {
    const report = evaluatePhase3MobilePaintGate([sample("text", 1, 20)], {
      minimumSamplesPerClass: { text_progress: 2, immediate: 3 },
    });

    expect(report.passed).toBe(false);
    expect(report.violations).toEqual(
      expect.arrayContaining([
        "missing required category progress",
        "missing required category approval",
        "missing required category question",
        "missing required category error",
        "missing required category completion",
        "text_progress requires at least 2 samples; received 1",
        "immediate requires at least 3 samples; received 0",
      ]),
    );
    expect(report.latencyByClass.immediate).toEqual({
      count: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    });
  });

  it("enforces a shared configurable minimum for both classes", () => {
    const report = evaluatePhase3MobilePaintGate(representativeSamples(), {
      minimumSamplesPerClass: 3,
    });

    expect(report.violations).toContain(
      "text_progress requires at least 3 samples; received 2",
    );
    expect(report.violations).not.toContain(
      "immediate requires at least 3 samples; received 4",
    );
  });

  it("reports invalid, negative, nonfinite, and mismatched clock data", () => {
    const samples = [
      ...representativeSamples(),
      sample("text", 7, 20, {
        correlationId: " ",
        eventId: "",
        ownerId: "",
        ownerGenerationId: "",
        ownerSequence: -1,
        sourceEventAt: -1,
        paintedAt: Number.POSITIVE_INFINITY,
        elapsedMs: Number.NaN,
      }),
      sample("progress", 8, 20, {
        paintedAt: 1_000 + 8_000 + 21,
      }),
      sample("approval", 9, 20, {
        ownerSequence: Number.MAX_SAFE_INTEGER + 1,
      }),
    ];

    const report = evaluatePhase3MobilePaintGate(samples);

    expect(report.passed).toBe(false);
    expect(report.violations).toEqual(
      expect.arrayContaining([
        "sample 6 correlationId must be a non-empty string",
        "sample 6 eventId must be a non-empty string",
        "sample 6 ownerId must be a non-empty string",
        "sample 6 ownerGenerationId must be a non-empty string",
        "sample 6 ownerSequence must be a nonnegative safe integer",
        "sample 6 sourceEventAt must be a finite nonnegative number",
        "sample 6 paintedAt must be a finite nonnegative number",
        "sample 6 elapsedMs must be a finite nonnegative number",
        "sample 7 elapsedMs does not match paintedAt - sourceEventAt",
        "sample 8 ownerSequence must be a nonnegative safe integer",
      ]),
    );
    expect(report.latencyByClass.text_progress.count).toBe(2);
  });

  it("rejects duplicate correlation IDs", () => {
    const samples = representativeSamples();
    const report = evaluatePhase3MobilePaintGate([
      ...samples,
      sample("text", 7, 20, {
        correlationId: samples[0].correlationId,
      }),
    ]);

    expect(report.violations).toContain(
      'sample 6 has duplicate correlationId "correlation-1"',
    );
  });

  it("rejects categories assigned to the wrong latency class", () => {
    const report = evaluatePhase3MobilePaintGate([
      ...representativeSamples(),
      sample("text", 7, 20, { latencyClass: "immediate" }),
      sample("completion", 8, 20, { latencyClass: "text_progress" }),
    ]);

    expect(report.violations).toEqual(
      expect.arrayContaining([
        "sample 6 category text must use latencyClass text_progress",
        "sample 7 category completion must use latencyClass immediate",
      ]),
    );
  });

  it("fails when either p95 is exactly its strict threshold", () => {
    const report = evaluatePhase3MobilePaintGate([
      sample("text", 1, 250),
      sample("progress", 2, 20),
      sample("approval", 3, 100),
      sample("question", 4, 10),
      sample("error", 5, 20),
      sample("completion", 6, 30),
    ]);

    expect(report.latencyByClass.text_progress.p95Ms).toBe(250);
    expect(report.latencyByClass.immediate.p95Ms).toBe(100);
    expect(report.violations).toEqual(
      expect.arrayContaining([
        "text_progress p95 must be below 250ms; received 250ms",
        "immediate p95 must be below 100ms; received 100ms",
      ]),
    );
  });
});
