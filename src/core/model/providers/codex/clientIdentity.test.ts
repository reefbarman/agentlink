import * as legacyIdentity from "./clientIdentity.js";
import * as packageCodex from "@agentlink/core/codex";

import { expect, it } from "vitest";

it("preserves the Codex client-identity compatibility facade", () => {
  expect(legacyIdentity).toEqual(
    expect.objectContaining({
      DEFAULT_CODEX_ORIGINATOR: packageCodex.DEFAULT_CODEX_ORIGINATOR,
      getCodexOriginator: packageCodex.getCodexOriginator,
      getCodexUserAgent: packageCodex.getCodexUserAgent,
    }),
  );
});
