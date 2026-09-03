import * as legacyTranslation from "./translation.js";
import * as packageCodex from "@agentlink/core/codex";

import { expect, expectTypeOf, it } from "vitest";

it("preserves the Codex translation compatibility facade", () => {
  expect(legacyTranslation).toEqual(
    expect.objectContaining({
      buildCodexEndpointRequestBody: packageCodex.buildCodexEndpointRequestBody,
      buildCodexResolvedRequestBody: packageCodex.buildCodexResolvedRequestBody,
      sanitizeCodexCallId: packageCodex.sanitizeCodexCallId,
      translateCodexMessages: packageCodex.translateCodexMessages,
      translateCodexTools: packageCodex.translateCodexTools,
    }),
  );
  expectTypeOf<legacyTranslation.CodexRequestBody>().toEqualTypeOf<packageCodex.CodexRequestBody>();
  expectTypeOf<legacyTranslation.CodexInputItem>().toEqualTypeOf<packageCodex.CodexInputItem>();
  expectTypeOf<legacyTranslation.CodexTool>().toEqualTypeOf<packageCodex.CodexTool>();
});
