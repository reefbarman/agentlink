/** @vitest-environment jsdom */

import "./BrowserGatewayApp.test";

// Runs the last third of BrowserGatewayApp.test.ts in parallel with the rest.
// See src/testing/testParts.ts.
import { vi } from "vitest";

vi.hoisted(() => {
  Reflect.set(globalThis, Symbol.for("agentlink.testPart"), { part: 3, of: 3 });
});
