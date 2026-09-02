import * as coreScheduler from "@agentlink/core/model-request-scheduler";
import * as legacyScheduler from "./modelRequestScheduler.js";

import { expect, expectTypeOf, it } from "vitest";

it("preserves the model request scheduler compatibility facade", () => {
  expect(legacyScheduler).toEqual(coreScheduler);
  expectTypeOf<legacyScheduler.ModelRequestPriority>().toEqualTypeOf<coreScheduler.ModelRequestPriority>();
  expectTypeOf<legacyScheduler.ModelRequestPermit>().toEqualTypeOf<coreScheduler.ModelRequestPermit>();
});
