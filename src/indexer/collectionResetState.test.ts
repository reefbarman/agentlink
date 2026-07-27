import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  INDEX_RESET_STATE_VERSION,
  beginIndexReset,
  completeIndexReset,
  getIndexResetStatePath,
  loadIndexResetState,
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
    expect(getIndexResetStatePath("/cache/workspace.json")).toBe(
      path.join("/cache", "workspace.reset.json"),
    );
    expect(getIndexResetStatePath("/cache/workspace")).toBe(
      "/cache/workspace.reset.json",
    );
  });

  it("reports a genuinely missing state without creating it", () => {
    expect(loadIndexResetState(statePath)).toEqual({ status: "missing" });
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("atomically checkpoints canonical neutral state", () => {
    const target = {
      storeRoot: "/storage/retrieval",
      workspaceScopeId: "workspace:abc123",
    };
    beginIndexReset(statePath, target);
    expect(loadIndexResetState(statePath)).toEqual({
      status: "valid",
      state: {
        version: INDEX_RESET_STATE_VERSION,
        status: "in-progress",
        target,
      },
    });
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual({
      version: INDEX_RESET_STATE_VERSION,
      status: "in-progress",
      target,
    });

    completeIndexReset(statePath, target);
    expect(loadIndexResetState(statePath)).toEqual({
      status: "valid",
      state: {
        version: INDEX_RESET_STATE_VERSION,
        status: "complete",
        target,
      },
    });
  });

  it.each([
    [
      "neutral canonical-only target",
      {
        version: 1,
        status: "complete",
        target: {
          storeRoot: "/storage/retrieval",
          workspaceScopeId: "workspace:abc123",
        },
      },
    ],
    [
      "previous canonical-only target",
      {
        version: 1,
        status: "complete",
        target: {
          endpoint: "/storage/retrieval",
          indexName: "workspace:abc123",
        },
      },
    ],
    [
      "legacy-only target",
      {
        version: 1,
        status: "complete",
        qdrantUrl: "/storage/retrieval",
        collectionName: "workspace:abc123",
      },
    ],
    [
      "matching dual target aliases",
      {
        version: 1,
        status: "complete",
        target: {
          endpoint: "/storage/retrieval",
          indexName: "workspace:abc123",
        },
        qdrantUrl: "/storage/retrieval",
        collectionName: "workspace:abc123",
      },
    ],
  ])("loads a %s into neutral runtime state", (_, content) => {
    fs.writeFileSync(statePath, JSON.stringify(content), "utf8");
    expect(loadIndexResetState(statePath)).toEqual({
      status: "valid",
      state: {
        version: INDEX_RESET_STATE_VERSION,
        status: "complete",
        target: {
          storeRoot: "/storage/retrieval",
          workspaceScopeId: "workspace:abc123",
        },
      },
    });
  });

  it("accepts equivalent normalized store-root aliases", () => {
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        status: "complete",
        target: {
          storeRoot: "/storage/retrieval/",
          workspaceScopeId: "workspace:abc123",
        },
        qdrantUrl: "/storage/retrieval",
        collectionName: "workspace:abc123",
      }),
      "utf8",
    );
    expect(loadIndexResetState(statePath)).toEqual({
      status: "valid",
      state: {
        version: INDEX_RESET_STATE_VERSION,
        status: "complete",
        target: {
          storeRoot: "/storage/retrieval/",
          workspaceScopeId: "workspace:abc123",
        },
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
    [
      "partial canonical target",
      JSON.stringify({
        version: 1,
        status: "complete",
        target: { endpoint: "http://qdrant" },
      }),
    ],
    [
      "partial legacy target",
      JSON.stringify({
        version: 1,
        status: "complete",
        qdrantUrl: "http://qdrant",
      }),
    ],
    [
      "conflicting endpoint aliases",
      JSON.stringify({
        version: 1,
        status: "complete",
        target: { endpoint: "http://canonical", indexName: "collection" },
        qdrantUrl: "http://legacy",
        collectionName: "collection",
      }),
    ],
    [
      "conflicting index aliases",
      JSON.stringify({
        version: 1,
        status: "complete",
        target: { endpoint: "http://qdrant", indexName: "canonical" },
        qdrantUrl: "http://qdrant",
        collectionName: "legacy",
      }),
    ],
  ])("rejects %s", (_, content) => {
    fs.writeFileSync(statePath, content, "utf8");
    expect(loadIndexResetState(statePath)).toMatchObject({
      status: "corrupt",
    });
  });

  it("rejects a dangling state symlink instead of treating it as missing", () => {
    fs.symlinkSync(path.join(directory, "missing-target"), statePath);
    expect(loadIndexResetState(statePath)).toMatchObject({
      status: "corrupt",
    });
  });
});
