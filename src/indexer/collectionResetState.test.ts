import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  COLLECTION_RESET_STATE_VERSION,
  beginCollectionReset,
  completeCollectionReset,
  getCollectionResetStatePath,
  loadCollectionResetState,
} from "./collectionResetState.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("collectionResetState", () => {
  let directory: string;
  let statePath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-reset-state-"),
    );
    statePath = path.join(directory, "index.reset.json");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("derives the reset path beside the vector cache", () => {
    expect(getCollectionResetStatePath("/cache/workspace.json")).toBe(
      path.join("/cache", "workspace.reset.json"),
    );
    expect(getCollectionResetStatePath("/cache/workspace")).toBe(
      "/cache/workspace.reset.json",
    );
  });

  it("reports a genuinely missing state without creating it", () => {
    expect(loadCollectionResetState(statePath)).toEqual({ status: "missing" });
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("atomically checkpoints target-bound in-progress and complete states", () => {
    const target = {
      qdrantUrl: "http://qdrant:6333",
      collectionName: "al-workspace",
    };
    beginCollectionReset(statePath, target);
    expect(loadCollectionResetState(statePath)).toEqual({
      status: "valid",
      state: {
        version: COLLECTION_RESET_STATE_VERSION,
        status: "in-progress",
        ...target,
      },
    });

    completeCollectionReset(statePath, target);
    expect(loadCollectionResetState(statePath)).toEqual({
      status: "valid",
      state: {
        version: COLLECTION_RESET_STATE_VERSION,
        status: "complete",
        ...target,
      },
    });
  });

  it.each([
    ["invalid JSON", "not json"],
    [
      "unsupported version",
      JSON.stringify({
        version: 2,
        status: "complete",
        qdrantUrl: "http://qdrant",
        collectionName: "collection",
      }),
    ],
    [
      "invalid status",
      JSON.stringify({
        version: 1,
        status: "starting",
        qdrantUrl: "http://qdrant",
        collectionName: "collection",
      }),
    ],
    ["missing target", JSON.stringify({ version: 1, status: "complete" })],
  ])("rejects %s", (_, content) => {
    fs.writeFileSync(statePath, content, "utf8");
    expect(loadCollectionResetState(statePath)).toMatchObject({
      status: "corrupt",
    });
  });

  it("rejects a dangling state symlink instead of treating it as missing", () => {
    fs.symlinkSync(path.join(directory, "missing-target"), statePath);
    expect(loadCollectionResetState(statePath)).toMatchObject({
      status: "corrupt",
    });
  });
});
