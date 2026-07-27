import * as path from "path";

import {
  RETRIEVAL_STORE_DIRECTORY,
  getRetrievalStoreRoot,
} from "./retrievalStorePaths.js";
import { describe, expect, it } from "vitest";

describe("retrieval store paths", () => {
  it("uses one stable AgentLink database root beneath global storage", () => {
    const globalStoragePath = path.join("tmp", "agentlink-storage");

    expect(getRetrievalStoreRoot(globalStoragePath)).toBe(
      path.join(globalStoragePath, RETRIEVAL_STORE_DIRECTORY),
    );
  });
});
