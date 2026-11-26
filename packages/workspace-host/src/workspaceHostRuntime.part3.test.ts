import "./workspaceHostRuntime.test.js";

// Runs the last third of workspaceHostRuntime.test.ts in parallel with the
// rest. See the note at the top of that file.
import { vi } from "vitest";

vi.hoisted(() => {
  Reflect.set(globalThis, Symbol.for("agentlink.testPart"), { part: 3, of: 3 });
});
