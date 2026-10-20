import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalizePath } from "./canonicalPath.js";

describe("canonicalizePath", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-canonical-")),
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves a missing path through its nearest existing parent", () => {
    expect(canonicalizePath(path.join(tempDir, "missing", "file.txt"))).toBe(
      path.join(tempDir, "missing", "file.txt"),
    );
  });

  it("maps case variants to the on-disk casing on case-insensitive volumes", () => {
    const filePath = path.join(tempDir, "Config.yaml");
    fs.writeFileSync(filePath, "", "utf-8");
    const variant = path.join(tempDir, "config.yaml");
    const caseInsensitive = fs.existsSync(variant);
    if (!caseInsensitive || process.platform === "win32") return;

    expect(canonicalizePath(variant)).toBe(filePath);
  });
});
