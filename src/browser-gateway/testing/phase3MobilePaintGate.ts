export const PHASE3_MOBILE_PAINT_CATEGORIES = [
  "text",
  "progress",
  "approval",
  "question",
  "error",
  "completion",
] as const;

export const PHASE3_MOBILE_PAINT_LATENCY_CLASSES = [
  "text_progress",
  "immediate",
] as const;

export type Phase3MobilePaintCategory =
  (typeof PHASE3_MOBILE_PAINT_CATEGORIES)[number];
export type Phase3MobilePaintLatencyClass =
  (typeof PHASE3_MOBILE_PAINT_LATENCY_CLASSES)[number];

/**
 * A browser-recorded source-event-to-paint sample. `sourceEventAt` originates
 * on the owner while `paintedAt` originates in the browser, so latency budgets
 * are authoritative only when those wall clocks are aligned (as they are in
 * the local production-backed fixture). Cross-device runs require clock-offset
 * calibration before they can be treated as a gate.
 */
export interface Phase3MobilePaintSample {
  readonly correlationId: string;
  readonly eventId: string;
  readonly ownerId: string;
  readonly ownerGenerationId: string;
  readonly ownerSequence: number;
  readonly eventKind: string;
  readonly category: Phase3MobilePaintCategory;
  readonly latencyClass: Phase3MobilePaintLatencyClass;
  readonly sourceEventAt: number;
  readonly paintedAt: number;
  readonly elapsedMs: number;
}

export interface Phase3MobilePaintLatencySummary {
  readonly count: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

export interface Phase3MobilePaintGateOptions {
  readonly minimumSamplesPerClass?:
    | number
    | Readonly<Record<Phase3MobilePaintLatencyClass, number>>;
}

export interface Phase3MobilePaintGateReport {
  readonly passed: boolean;
  readonly violations: readonly string[];
  readonly latencyByClass: Readonly<
    Record<Phase3MobilePaintLatencyClass, Phase3MobilePaintLatencySummary>
  >;
  readonly categoryCounts: Readonly<Record<Phase3MobilePaintCategory, number>>;
}

const DEFAULT_MINIMUM_SAMPLES_PER_CLASS = 1;
const CLOCK_TOLERANCE_MS = 1e-6;
const P95_LIMITS_MS: Readonly<Record<Phase3MobilePaintLatencyClass, number>> = {
  text_progress: 250,
  immediate: 100,
};
const EXPECTED_LATENCY_CLASS: Readonly<
  Record<Phase3MobilePaintCategory, Phase3MobilePaintLatencyClass>
> = {
  text: "text_progress",
  progress: "text_progress",
  approval: "immediate",
  question: "immediate",
  error: "immediate",
  completion: "immediate",
};

export function evaluatePhase3MobilePaintGate(
  samples: readonly Phase3MobilePaintSample[],
  options: Phase3MobilePaintGateOptions = {},
): Phase3MobilePaintGateReport {
  const violations: string[] = [];
  const categoryCounts = createCategoryCounts();
  const latenciesByClass: Record<Phase3MobilePaintLatencyClass, number[]> = {
    text_progress: [],
    immediate: [],
  };
  const seenCorrelationIds = new Set<string>();

  for (const [index, sample] of samples.entries()) {
    const prefix = `sample ${index}`;

    const validCorrelationId = validateNonEmptyId(
      sample.correlationId,
      "correlationId",
      prefix,
      violations,
    );
    const validEventId = validateNonEmptyId(
      sample.eventId,
      "eventId",
      prefix,
      violations,
    );
    const validOwnerId = validateNonEmptyId(
      sample.ownerId,
      "ownerId",
      prefix,
      violations,
    );
    const validOwnerGenerationId = validateNonEmptyId(
      sample.ownerGenerationId,
      "ownerGenerationId",
      prefix,
      violations,
    );

    let uniqueCorrelationId = validCorrelationId;
    if (validCorrelationId) {
      if (seenCorrelationIds.has(sample.correlationId)) {
        violations.push(
          `${prefix} has duplicate correlationId ${JSON.stringify(sample.correlationId)}`,
        );
        uniqueCorrelationId = false;
      } else {
        seenCorrelationIds.add(sample.correlationId);
      }
    }

    const validOwnerSequence =
      Number.isSafeInteger(sample.ownerSequence) && sample.ownerSequence >= 0;
    if (!validOwnerSequence) {
      violations.push(
        `${prefix} ownerSequence must be a nonnegative safe integer`,
      );
    }

    const validSourceEventAt = validateFiniteNonnegativeNumber(
      sample.sourceEventAt,
      "sourceEventAt",
      prefix,
      violations,
    );
    const validPaintedAt = validateFiniteNonnegativeNumber(
      sample.paintedAt,
      "paintedAt",
      prefix,
      violations,
    );
    const validElapsed = validateFiniteNonnegativeNumber(
      sample.elapsedMs,
      "elapsedMs",
      prefix,
      violations,
    );
    // This checks sample self-consistency, not synchronization between the
    // owner and browser clocks. See Phase3MobilePaintSample's trust boundary.
    const matchingClock =
      validSourceEventAt &&
      validPaintedAt &&
      validElapsed &&
      Math.abs(sample.paintedAt - sample.sourceEventAt - sample.elapsedMs) <=
        CLOCK_TOLERANCE_MS;

    if (
      validSourceEventAt &&
      validPaintedAt &&
      validElapsed &&
      !matchingClock
    ) {
      violations.push(
        `${prefix} elapsedMs does not match paintedAt - sourceEventAt`,
      );
    }

    const category = isCategory(sample.category) ? sample.category : null;
    const latencyClass = isLatencyClass(sample.latencyClass)
      ? sample.latencyClass
      : null;

    if (category === null) {
      violations.push(
        `${prefix} has invalid category ${JSON.stringify(sample.category)}`,
      );
    }

    if (latencyClass === null) {
      violations.push(
        `${prefix} has invalid latencyClass ${JSON.stringify(sample.latencyClass)}`,
      );
    }

    const matchingLatencyClass =
      category !== null &&
      latencyClass !== null &&
      EXPECTED_LATENCY_CLASS[category] === latencyClass;
    if (category !== null && latencyClass !== null && !matchingLatencyClass) {
      violations.push(
        `${prefix} category ${category} must use latencyClass ${EXPECTED_LATENCY_CLASS[category]}`,
      );
    }

    if (
      validCorrelationId &&
      uniqueCorrelationId &&
      validEventId &&
      validOwnerId &&
      validOwnerGenerationId &&
      validOwnerSequence &&
      matchingClock &&
      matchingLatencyClass
    ) {
      categoryCounts[category] += 1;
      latenciesByClass[latencyClass].push(sample.elapsedMs);
    }
  }

  for (const category of PHASE3_MOBILE_PAINT_CATEGORIES) {
    if (categoryCounts[category] === 0) {
      violations.push(`missing required category ${category}`);
    }
  }

  const minimumSamples = resolveMinimumSamples(options, violations);
  const latencyByClass = {
    text_progress: summarizeLatencies(latenciesByClass.text_progress),
    immediate: summarizeLatencies(latenciesByClass.immediate),
  } satisfies Record<
    Phase3MobilePaintLatencyClass,
    Phase3MobilePaintLatencySummary
  >;

  for (const latencyClass of PHASE3_MOBILE_PAINT_LATENCY_CLASSES) {
    const summary = latencyByClass[latencyClass];
    if (summary.count < minimumSamples[latencyClass]) {
      violations.push(
        `${latencyClass} requires at least ${minimumSamples[latencyClass]} samples; received ${summary.count}`,
      );
    }
    if (
      summary.p95Ms !== null &&
      summary.p95Ms >= P95_LIMITS_MS[latencyClass]
    ) {
      violations.push(
        `${latencyClass} p95 must be below ${P95_LIMITS_MS[latencyClass]}ms; received ${summary.p95Ms}ms`,
      );
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    latencyByClass,
    categoryCounts,
  };
}

function createCategoryCounts(): Record<Phase3MobilePaintCategory, number> {
  return {
    text: 0,
    progress: 0,
    approval: 0,
    question: 0,
    error: 0,
    completion: 0,
  };
}

function validateNonEmptyId(
  value: unknown,
  field: string,
  prefix: string,
  violations: string[],
): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    violations.push(`${prefix} ${field} must be a non-empty string`);
    return false;
  }
  return true;
}

function validateFiniteNonnegativeNumber(
  value: unknown,
  field: string,
  prefix: string,
  violations: string[],
): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    violations.push(`${prefix} ${field} must be a finite nonnegative number`);
    return false;
  }
  return true;
}

function isCategory(value: unknown): value is Phase3MobilePaintCategory {
  return (PHASE3_MOBILE_PAINT_CATEGORIES as readonly unknown[]).includes(value);
}

function isLatencyClass(
  value: unknown,
): value is Phase3MobilePaintLatencyClass {
  return (PHASE3_MOBILE_PAINT_LATENCY_CLASSES as readonly unknown[]).includes(
    value,
  );
}

function resolveMinimumSamples(
  options: Phase3MobilePaintGateOptions,
  violations: string[],
): Record<Phase3MobilePaintLatencyClass, number> {
  const configured =
    options.minimumSamplesPerClass ?? DEFAULT_MINIMUM_SAMPLES_PER_CLASS;
  const resolved =
    typeof configured === "number"
      ? { text_progress: configured, immediate: configured }
      : configured;

  return {
    text_progress: validateMinimumSampleCount(
      resolved?.text_progress,
      "text_progress",
      violations,
    ),
    immediate: validateMinimumSampleCount(
      resolved?.immediate,
      "immediate",
      violations,
    ),
  };
}

function validateMinimumSampleCount(
  value: number | undefined,
  latencyClass: Phase3MobilePaintLatencyClass,
  violations: string[],
): number {
  if (value === undefined) {
    violations.push(`minimumSamplesPerClass.${latencyClass} is required`);
    return DEFAULT_MINIMUM_SAMPLES_PER_CLASS;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    violations.push(
      `minimumSamplesPerClass.${latencyClass} must be a positive safe integer`,
    );
    return DEFAULT_MINIMUM_SAMPLES_PER_CLASS;
  }
  return value;
}

function summarizeLatencies(
  latencies: readonly number[],
): Phase3MobilePaintLatencySummary {
  if (latencies.length === 0) {
    return { count: 0, p50Ms: null, p95Ms: null, maxMs: null };
  }

  const sorted = [...latencies].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50Ms: nearestRank(sorted, 0.5),
    p95Ms: nearestRank(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
  };
}

function nearestRank(
  sortedValues: readonly number[],
  percentile: number,
): number {
  const rank = Math.ceil(percentile * sortedValues.length);
  return sortedValues[Math.max(0, rank - 1)];
}
