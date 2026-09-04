import * as legacyCompletion from "./completionFacade.js";
import * as packageCodex from "@agentlink/core/codex";

import { expect, expectTypeOf, it } from "vitest";

it("preserves the Codex completion compatibility facade", () => {
  expect(legacyCompletion).toEqual(
    expect.objectContaining({
      CodexResponsesAuthError: packageCodex.CodexResponsesAuthError,
      CodexResponsesStreamAbortedError:
        packageCodex.CodexResponsesStreamAbortedError,
      collectCodexCompletionResult: packageCodex.collectCodexCompletionResult,
      executeCodexResolvedCompletion:
        packageCodex.executeCodexResolvedCompletion,
    }),
  );
  expectTypeOf<legacyCompletion.CodexCompletionResult>().toEqualTypeOf<packageCodex.CodexCompletionResult>();
  expectTypeOf<legacyCompletion.CodexCompletionToolCall>().toEqualTypeOf<packageCodex.CodexCompletionToolCall>();
});
