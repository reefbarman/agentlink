import * as legacyModels from "./models.js";
import * as packageModels from "@agentlink/core/codex";

import { expect, expectTypeOf, it } from "vitest";

it("preserves the Codex model-policy compatibility facade", () => {
  expect(legacyModels).toEqual(packageModels);
  expectTypeOf<legacyModels.CodexAuthMethod>().toEqualTypeOf<packageModels.CodexAuthMethod>();
  expectTypeOf<legacyModels.CodexModelDef>().toEqualTypeOf<packageModels.CodexModelDef>();
  expectTypeOf<legacyModels.ResponsesCaps>().toEqualTypeOf<packageModels.ResponsesCaps>();
});
