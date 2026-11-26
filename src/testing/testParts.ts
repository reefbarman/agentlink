import { describe as baseDescribe, it as baseIt } from "vitest";

// Vitest runs test files in parallel but the tests inside one file in order,
// so a full run can never finish sooner than its longest file. A long file
// whose tests are independent can run as several files instead:
//
//   1. In `foo.test.ts`, replace the imported `it` with
//      `const { it } = partitionTests(3);`.
//   2. Add `foo.part2.test.ts` and `foo.part3.test.ts`, each containing only:
//
//        import { vi } from "vitest";
//        import "./foo.test";
//
//        vi.hoisted(() => {
//          Reflect.set(globalThis, Symbol.for("agentlink.testPart"), {
//            part: 2,
//            of: 3,
//          });
//        });
//
//      plus the same `@vitest-environment` comment as `foo.test.ts`, if any.
//
// `foo.test.ts` then runs every third test, and each part file runs its own
// third with the same setup. Every part number from 2 to the total needs a
// file: nothing runs the tests of a part whose file is missing.
//
// Tests that run in different parts run at the same time, so they must not
// share fixed ports, fixed paths or other machine-wide state.

const SELECTED_PART = Symbol.for("agentlink.testPart");

/** `it` modifiers that take arguments and return the function that registers. */
const REGISTRAR_FACTORIES = new Set<PropertyKey>([
  "each",
  "for",
  "runIf",
  "skipIf",
]);

export interface PartitionedTests {
  /**
   * Registers only the tests belonging to the part of the file being run.
   * Tests are dealt out in turn in the order they are declared, and a whole
   * `it.each` table goes to one part.
   */
  it: typeof baseIt;
  /**
   * A `describe` whose tests all run in the first part. Vitest fails a
   * `describe` left with no tests, which happens when a group has fewer tests
   * than there are parts, so use this for small groups.
   */
  describeTogether: (name: string, factory: () => void) => void;
}

export function partitionTests(parts: number): PartitionedTests {
  const selected: { part: number; of: number } = Reflect.get(
    globalThis,
    SELECTED_PART,
  ) ?? { part: 1, of: parts };
  if (
    selected.of !== parts ||
    !Number.isInteger(selected.part) ||
    selected.part < 1 ||
    selected.part > parts
  ) {
    throw new Error(
      `Test part ${selected.part} of ${selected.of} does not match a file split into ${parts} parts`,
    );
  }

  let declared = 0;
  let together = false;
  const isMine = () => together || declared++ % parts === selected.part - 1;
  const notMine = () => {};

  const it = new Proxy(baseIt, {
    apply: (target, thisArgument, argumentsList) =>
      isMine() ? Reflect.apply(target, thisArgument, argumentsList) : undefined,
    get(target, property) {
      const value = Reflect.get(target, property);
      if (!REGISTRAR_FACTORIES.has(property) || typeof value !== "function") {
        return value;
      }
      return (...factoryArguments: unknown[]) =>
        isMine() ? Reflect.apply(value, target, factoryArguments) : notMine;
    },
  });

  const describeTogether: PartitionedTests["describeTogether"] =
    selected.part === 1
      ? (name, factory) =>
          baseDescribe(name, () => {
            together = true;
            try {
              factory();
            } finally {
              together = false;
            }
          })
      : notMine;

  return { it, describeTogether };
}
