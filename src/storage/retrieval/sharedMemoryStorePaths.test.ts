import * as path from "path";

import {
  SHARED_MEMORY_CONFIG_FILE,
  SHARED_MEMORY_STATE_DIRECTORY,
  SHARED_MEMORY_STORE_DIRECTORY,
  getSharedMemoryConfigPath,
  getSharedMemoryStoreRoot,
} from "./sharedMemoryStorePaths.js";
import { describe, expect, it } from "vitest";

describe("shared memory store paths", () => {
  it("places the canonical memory store beneath the AgentLink home directory", () => {
    const homeDir = path.join("tmp", "agentlink-home");

    expect(getSharedMemoryStoreRoot(homeDir)).toBe(
      path.join(
        homeDir,
        SHARED_MEMORY_STATE_DIRECTORY,
        SHARED_MEMORY_STORE_DIRECTORY,
      ),
    );
  });

  it("places the canonical memory config beside the store", () => {
    const homeDir = path.join("tmp", "agentlink-home");

    expect(getSharedMemoryConfigPath(homeDir)).toBe(
      path.join(
        homeDir,
        SHARED_MEMORY_STATE_DIRECTORY,
        SHARED_MEMORY_CONFIG_FILE,
      ),
    );
  });

  it("defaults to the current user's home directory", () => {
    expect(getSharedMemoryStoreRoot()).toContain(
      path.join(SHARED_MEMORY_STATE_DIRECTORY, SHARED_MEMORY_STORE_DIRECTORY),
    );
    expect(getSharedMemoryConfigPath()).toContain(
      path.join(SHARED_MEMORY_STATE_DIRECTORY, SHARED_MEMORY_CONFIG_FILE),
    );
  });
});
