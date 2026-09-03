import * as legacyClient from "./openaiClient.js";
import * as packageCodex from "@agentlink/core/codex";

import { expect, expectTypeOf, it } from "vitest";

it("preserves the Codex OpenAI-client compatibility facade", () => {
  expect(legacyClient).toEqual(
    expect.objectContaining({
      CODEX_API_BASE_URL: packageCodex.CODEX_API_BASE_URL,
      OPENAI_API_BASE_URL: packageCodex.OPENAI_API_BASE_URL,
      buildCodexClientCacheKey: packageCodex.buildCodexClientCacheKey,
      createOpenAiResponsesClient: packageCodex.createOpenAiResponsesClient,
      getCodexEndpointConfig: packageCodex.getCodexEndpointConfig,
    }),
  );
  expectTypeOf<legacyClient.CodexEndpointConfig>().toEqualTypeOf<packageCodex.CodexEndpointConfig>();
  expectTypeOf<legacyClient.CodexResolvedAuthForClient>().toEqualTypeOf<packageCodex.CodexResolvedAuthForClient>();
});
