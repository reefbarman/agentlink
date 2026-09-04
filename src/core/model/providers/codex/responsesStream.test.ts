import * as legacyStream from "./responsesStream.js";
import * as packageCodex from "@agentlink/core/codex";

import { expect, expectTypeOf, it } from "vitest";

it("preserves the Codex Responses-stream compatibility facade", () => {
  expect(legacyStream).toEqual(
    expect.objectContaining({
      CodexResponsesAuthError: packageCodex.CodexResponsesAuthError,
      CodexResponsesStreamAbortedError:
        packageCodex.CodexResponsesStreamAbortedError,
      executeCodexResponsesStream: packageCodex.executeCodexResponsesStream,
    }),
  );
  expectTypeOf<legacyStream.CodexResponsesClient>().toEqualTypeOf<packageCodex.CodexResponsesClient>();
});
