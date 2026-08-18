import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveContainedPath,
  resolvePackagePath,
  resolveRootedRuntimePath,
} from "./pathPolicy.js";

import { createTestPluginPackageFileSystem } from "../../test/pluginPackageFileSystem.js";
import os from "node:os";
import path from "node:path";

describe("Agent Plugin path policy", () => {
  let root: string;
  let outside: string;
  const fileSystem = createTestPluginPackageFileSystem();

  beforeEach(async () => {
    const temp = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "agentlink-plugin-path-")),
    );
    root = path.join(temp, "plugin");
    outside = path.join(temp, "outside");
    await fs.mkdir(path.join(root, "bin"), { recursive: true });
    await fs.mkdir(outside);
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  it("accepts a contained missing leaf using its existing ancestor", async () => {
    const result = await resolvePackagePath(
      fileSystem,
      root,
      "./bin/generated/server",
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        resolvedPath: path.join(root, "bin", "generated", "server"),
        missingSegments: ["generated", "server"],
      }),
    );
  });

  it("rejects lexical traversal", async () => {
    await expect(
      resolvePackagePath(fileSystem, root, "./../outside"),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, code: "lexical_escape" }),
    );
  });

  it("rejects an existing ancestor symlink that escapes", async () => {
    await fs.symlink(outside, path.join(root, "linked"));
    await expect(
      resolvePackagePath(fileSystem, root, "./linked/generated"),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, code: "realpath_escape" }),
    );
  });

  it("accepts rooted cwd forms and rejects unsupported forms", async () => {
    const data = path.join(path.dirname(root), "data");
    await fs.mkdir(data);
    await expect(
      resolveRootedRuntimePath(fileSystem, "${PLUGIN_DATA}/cache", {
        pluginRoot: root,
        pluginData: data,
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));
    await expect(
      resolveRootedRuntimePath(fileSystem, "/tmp/cache", {
        pluginRoot: root,
        pluginData: data,
      }),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, code: "invalid_relative_path" }),
    );
  });

  it("rejects a candidate outside an otherwise valid root", async () => {
    await expect(
      resolveContainedPath(fileSystem, root, outside),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, code: "lexical_escape" }),
    );
  });
});
