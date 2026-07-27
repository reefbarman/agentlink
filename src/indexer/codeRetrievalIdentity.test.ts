import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";
import {
  getCodeRelationId,
  getCodeSourceId,
  getCodeWorkspaceScopeId,
} from "./codeRetrievalIdentity.js";

describe("code retrieval identity", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses canonical workspace identity while isolating different roots", () => {
    const physical = fs.mkdtempSync(path.join(os.tmpdir(), "code-scope-"));
    roots.push(physical);
    const alias = `${physical}-alias`;
    fs.symlinkSync(physical, alias, "dir");
    roots.push(alias);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "code-scope-other-"));
    roots.push(other);

    expect(getCodeWorkspaceScopeId(alias)).toBe(
      getCodeWorkspaceScopeId(physical),
    );
    expect(getCodeWorkspaceScopeId(other)).not.toBe(
      getCodeWorkspaceScopeId(physical),
    );
  });

  it("combines workspace scope and canonical portable path without accepting non-canonical input", () => {
    const first = getCodeSourceId("workspace:first", "src/index.ts");
    const second = getCodeSourceId("workspace:second", "src/index.ts");

    expect(first).toBe("code:workspace:first:src/index.ts");
    expect(second).not.toBe(first);
    expect(() => getCodeSourceId("workspace:first", "src\\index.ts")).toThrow();
    expect(() => getCodeSourceId("workspace:first", "../index.ts")).toThrow();
  });

  it("derives deterministic relation identities from the complete owner tuple", () => {
    const input = {
      sourceId: "code:workspace:first:src/index.ts",
      revisionId: "revision-1",
      generation: "generation-1",
      kind: "imports",
      fromId: "code:workspace:first:src/index.ts",
      toId: "code:workspace:first:src/helper.ts",
      ordinal: 0,
    };

    expect(getCodeRelationId(input)).toBe(getCodeRelationId({ ...input }));
    expect(getCodeRelationId({ ...input, ordinal: 1 })).not.toBe(
      getCodeRelationId(input),
    );
  });
});
