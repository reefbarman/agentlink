import * as legacyParser from "./streamParser.js";
import * as packageCodex from "@agentlink/core/codex";

import { expect, expectTypeOf, it } from "vitest";

it("preserves the Codex stream-parser compatibility facade", () => {
  expect(legacyParser).toEqual(
    expect.objectContaining({
      CodexStreamError: packageCodex.CodexStreamError,
      parseCodexResponseStreamEvents:
        packageCodex.parseCodexResponseStreamEvents,
    }),
  );
  expectTypeOf<legacyParser.CodexStreamParserState>().toEqualTypeOf<packageCodex.CodexStreamParserState>();
  expectTypeOf<legacyParser.CodexStreamParserOptions>().toEqualTypeOf<packageCodex.CodexStreamParserOptions>();
});
