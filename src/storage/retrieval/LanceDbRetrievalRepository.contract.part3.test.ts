import "./LanceDbRetrievalRepository.contract.test.js";

// Runs the last third of LanceDbRetrievalRepository.contract.test.ts in
// parallel with the rest. See src/testing/testParts.ts.
import { vi } from "vitest";

vi.hoisted(() => {
  Reflect.set(globalThis, Symbol.for("agentlink.testPart"), { part: 3, of: 3 });
});
