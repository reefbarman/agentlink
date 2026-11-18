// Copied next to each holdout script in a disposable verifier workspace.
// Results are printed on one marker line so stray console output from the
// code under test cannot be mistaken for a verdict.

const results = [];

export async function check(id, fn) {
  try {
    const outcome = await fn();
    results.push(
      outcome === true
        ? { id, pass: true }
        : { id, pass: false, detail: String(outcome) },
    );
  } catch (error) {
    results.push({
      id,
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export function expectEqual(actual, expected, label) {
  return Object.is(actual, expected)
    ? true
    : `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

export function firstFailure(...outcomes) {
  return outcomes.find((outcome) => outcome !== true) ?? true;
}

export function finish() {
  console.log(`__MODEL_BENCH_RESULTS__${JSON.stringify(results)}`);
}
