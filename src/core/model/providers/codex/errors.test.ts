import * as legacyErrors from "./errors.js";
import * as packageCodex from "@agentlink/core/codex";

import { expect, expectTypeOf, it } from "vitest";

it("preserves the Codex error compatibility facade", () => {
  expect(legacyErrors).toEqual(
    expect.objectContaining({
      CodexRequestError: packageCodex.CodexRequestError,
      buildCodexApiErrorDetails: packageCodex.buildCodexApiErrorDetails,
      getCodexErrorHandlingAction: packageCodex.getCodexErrorHandlingAction,
      toCodexRequestError: packageCodex.toCodexRequestError,
    }),
  );
  expectTypeOf<legacyErrors.CodexErrorShape>().toEqualTypeOf<packageCodex.CodexErrorShape>();
  expectTypeOf<legacyErrors.CodexErrorDetails>().toEqualTypeOf<packageCodex.CodexErrorDetails>();
});
