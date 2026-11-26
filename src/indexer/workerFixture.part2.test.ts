import "./workerFixture.test.js";

// Runs the second third of workerFixture.test.ts in parallel with the rest.
// See src/testing/testParts.ts.
import { vi } from "vitest";

vi.hoisted(() => {
  Reflect.set(globalThis, Symbol.for("agentlink.testPart"), { part: 2, of: 3 });
});
