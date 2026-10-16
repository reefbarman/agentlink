import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assessDelegatedWriteScopes,
  formatUnavailableDelegatedWriteScopes,
  type DelegatedWriteAuthorityReader,
} from "./delegatedWriteScopePreflight.js";

import type { PathRule } from "../approvals/PathRuleStore.js";

const root = "/work/app";
const sibling = "/work/sibling";

function authority(
  overrides: Partial<{
    trusted: (filePath: string) => boolean;
    writable: (filePath: string) => boolean;
    pathRules: PathRule[];
    writeRules: PathRule[];
  }> = {},
): DelegatedWriteAuthorityReader {
  return {
    isPathTrusted: overrides.trusted ?? (() => false),
    isWriteAllowed: overrides.writable ?? (() => false),
    pathRules: () => overrides.pathRules ?? [],
    writeRules: () => overrides.writeRules ?? [],
  };
}

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("assessDelegatedWriteScopes", () => {
  it("ignores scopes inside any workspace root, including relative scopes", () => {
    const result = assessDelegatedWriteScopes({
      ownedPaths: ["src/owned.ts", `${root}/scripts`, "/work/other/lib"],
      executionRoot: root,
      workspaceRoots: [root, "/work/other"],
      authority: authority(),
    });
    expect(result).toEqual({ unavailable: [], warnings: [] });
  });

  it("rejects an outside sibling scope with no inherited authority", () => {
    const result = assessDelegatedWriteScopes({
      ownedPaths: [`${sibling}/packages/core`, "../sibling/scripts"],
      executionRoot: root,
      workspaceRoots: [root],
      authority: authority({
        writeRules: [{ pattern: "src/**", mode: "glob" }],
      }),
    });
    expect(result.unavailable).toEqual([
      {
        ownedPath: `${sibling}/packages/core`,
        resolvedPath: `${sibling}/packages/core`,
        missing: ["path_trust", "write_authority"],
      },
      {
        ownedPath: "../sibling/scripts",
        resolvedPath: `${sibling}/scripts`,
        missing: ["path_trust", "write_authority"],
      },
    ]);
    const message = formatUnavailableDelegatedWriteScopes(result.unavailable);
    expect(message).toContain("missing path trust and write approval");
    expect(message).toContain("workspace folder");
  });

  it("reports only the missing half when one kind of authority exists", () => {
    const result = assessDelegatedWriteScopes({
      ownedPaths: [sibling],
      executionRoot: root,
      workspaceRoots: [root],
      authority: authority({
        pathRules: [{ pattern: sibling, mode: "prefix" }],
      }),
    });
    expect(result.unavailable[0]?.missing).toEqual(["write_authority"]);
  });

  it("accepts an outside scope covered by directory-level authority", () => {
    const covered = (filePath: string) =>
      filePath === sibling || filePath.startsWith(`${sibling}/`);
    const result = assessDelegatedWriteScopes({
      ownedPaths: [`${sibling}/src`],
      executionRoot: root,
      workspaceRoots: [root],
      authority: authority({ trusted: covered, writable: covered }),
    });
    expect(result).toEqual({ unavailable: [], warnings: [] });
  });

  it("warns instead of rejecting when only narrower grants exist beneath the scope", () => {
    const result = assessDelegatedWriteScopes({
      ownedPaths: [sibling],
      executionRoot: root,
      workspaceRoots: [root],
      authority: authority({
        pathRules: [{ pattern: `${sibling}/src/**`, mode: "glob" }],
        writeRules: [{ pattern: `${sibling}/src/index.ts`, mode: "exact" }],
      }),
    });
    expect(result.unavailable).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(sibling);
  });

  it("treats leading-wildcard globs as possibly covering any path", () => {
    const result = assessDelegatedWriteScopes({
      ownedPaths: [sibling],
      executionRoot: root,
      workspaceRoots: [root],
      authority: authority({
        pathRules: [{ pattern: "**/sibling/**", mode: "glob" }],
        writeRules: [{ pattern: "**/*.ts", mode: "glob" }],
      }),
    });
    expect(result.unavailable).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it("does not treat unrelated outside rules as reaching the scope", () => {
    const result = assessDelegatedWriteScopes({
      ownedPaths: [sibling],
      executionRoot: root,
      workspaceRoots: [root],
      authority: authority({
        pathRules: [{ pattern: "/work/elsewhere/**", mode: "glob" }],
        writeRules: [{ pattern: "/work/elsewhere", mode: "prefix" }],
      }),
    });
    expect(result.unavailable[0]?.missing).toEqual([
      "path_trust",
      "write_authority",
    ]);
  });

  it("treats a symlink into a workspace root as inside the workspace", () => {
    const base = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-owned-scope-")),
    );
    tempDirectories.push(base);
    const workspace = path.join(base, "workspace");
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    const alias = path.join(base, "alias");
    fs.symlinkSync(workspace, alias);
    const result = assessDelegatedWriteScopes({
      ownedPaths: [path.join(alias, "src")],
      executionRoot: workspace,
      workspaceRoots: [workspace],
      authority: authority(),
    });
    expect(result).toEqual({ unavailable: [], warnings: [] });
  });
});
