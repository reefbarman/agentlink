/** @vitest-environment node */

import "./browserGatewayHelper.integration.test.js";

// Runs the second third of browserGatewayHelper.integration.test.ts in
// parallel with the rest. See src/testing/testParts.ts.
import { vi } from "vitest";

vi.hoisted(() => {
  Reflect.set(globalThis, Symbol.for("agentlink.testPart"), { part: 2, of: 3 });
});
