import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractStructuralFile } from "./structuralExtractor.js";
import { hashContent } from "./workerLib.js";

function normalize(entries: unknown): unknown {
  return JSON.parse(JSON.stringify(entries));
}

describe("extractStructuralFile", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "structural-extractor-"),
    );
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string): string {
    const absPath = path.join(workspaceRoot, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf-8");
    return absPath;
  }

  function extract(relPath: string, content: string) {
    const absPath = writeFile(relPath, content);
    const stat = fs.statSync(absPath);
    return extractStructuralFile({
      content,
      absPath,
      relPath,
      workspaceRoot,
      hash: hashContent(content),
      indexedAt: "2026-01-01T00:00:00.000Z",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  it("extracts static JS/TS imports and resolves relative specifiers", () => {
    writeFile("src/bar.ts", "export const Bar = 1;");
    writeFile("src/util/index.ts", "export const util = 1;");
    const entry = extract(
      "src/foo.ts",
      [
        'import defaultThing, { Bar as LocalBar, Baz } from "./bar";',
        'import * as util from "./util";',
        'import type { External } from "pkg";',
      ].join("\n"),
    );

    expect(normalize(entry.imports)).toEqual([
      {
        specifier: "./bar",
        kind: "static",
        imported: ["default", "LocalBar", "Baz"],
        resolvedRelPath: "src/bar.ts",
        line: 1,
      },
      {
        specifier: "./util",
        kind: "static",
        imported: ["*"],
        resolvedRelPath: "src/util/index.ts",
        line: 2,
      },
      {
        specifier: "pkg",
        kind: "static",
        imported: ["External"],
        external: true,
        line: 3,
      },
    ]);
  });

  it("extracts multi-line static imports", () => {
    writeFile(
      "src/workerLib.ts",
      "export const loadStructuralCache = () => null;",
    );
    writeFile("src/structuralGraph.ts", "export interface StructuralImport {}");
    const entry = extract(
      "src/foo.ts",
      [
        "import {",
        "  getStructuralCachePath,",
        "  hashContent,",
        "  loadStructuralCache,",
        '} from "./workerLib.js";',
        "import type {",
        "  StructuralFileEntry,",
        "  StructuralGraphCache,",
        "  StructuralImport,",
        '} from "./structuralGraph.js";',
      ].join("\n"),
    );

    expect(normalize(entry.imports)).toEqual([
      {
        specifier: "./workerLib.js",
        kind: "static",
        imported: [
          "getStructuralCachePath",
          "hashContent",
          "loadStructuralCache",
        ],
        resolvedRelPath: "src/workerLib.ts",
        line: 1,
      },
      {
        specifier: "./structuralGraph.js",
        kind: "static",
        imported: [
          "StructuralFileEntry",
          "StructuralGraphCache",
          "StructuralImport",
        ],
        resolvedRelPath: "src/structuralGraph.ts",
        line: 6,
      },
    ]);
  });

  it("resolves generated .js specifiers to TypeScript source files", () => {
    writeFile("src/getModuleNeighbors.ts", "export const handle = true;");
    const entry = extract(
      "src/toolAdapter.ts",
      'import { handle } from "./getModuleNeighbors.js";',
    );

    expect(entry.imports).toEqual([
      {
        specifier: "./getModuleNeighbors.js",
        kind: "static",
        imported: ["handle"],
        resolvedRelPath: "src/getModuleNeighbors.ts",
        line: 1,
      },
    ]);
  });

  it("extracts reexports and export declarations", () => {
    writeFile("src/bar.ts", "export const Bar = 1;");
    const entry = extract(
      "src/foo.ts",
      [
        'export { Bar as RenamedBar } from "./bar";',
        'export * from "./bar";',
        "export function run() {}",
        "export class Runner {}",
        "export const value = 1;",
        "export default function main() {}",
      ].join("\n"),
    );

    expect(entry.imports).toEqual([
      {
        specifier: "./bar",
        kind: "reexport",
        imported: ["RenamedBar"],
        resolvedRelPath: "src/bar.ts",
        line: 1,
      },
      {
        specifier: "./bar",
        kind: "reexport",
        resolvedRelPath: "src/bar.ts",
        line: 2,
      },
    ]);
    expect(entry.exports).toEqual([
      {
        name: "RenamedBar",
        kind: "reexport",
        source: "./bar",
        resolvedRelPath: "src/bar.ts",
        line: 1,
      },
      {
        name: "*",
        kind: "reexport",
        source: "./bar",
        resolvedRelPath: "src/bar.ts",
        line: 2,
      },
      { name: "run", kind: "named", line: 3 },
      { name: "Runner", kind: "named", line: 4 },
      { name: "value", kind: "named", line: 5 },
      { name: "main", kind: "default", line: 6 },
    ]);
    expect(entry.symbols).toEqual([
      { name: "run", kind: "function", exported: true, line: 3 },
      { name: "Runner", kind: "class", exported: true, line: 4 },
      { name: "value", kind: "const", exported: true, line: 5 },
      { name: "main", kind: "function", exported: true, line: 6 },
    ]);
  });

  it("extracts CommonJS requires and exports", () => {
    writeFile("lib/util.js", "exports.util = 1;");
    const entry = extract(
      "lib/foo.js",
      [
        'const util = require("./util");',
        'const fs = require("fs");',
        "// exports.commentOnly = true;",
        'const text = "module.exports = nope";',
        "exports.makeFoo = () => util;",
        "module.exports = { other: true };",
      ].join("\n"),
    );

    expect(entry.imports).toEqual([
      {
        specifier: "./util",
        kind: "require",
        resolvedRelPath: "lib/util.js",
        line: 1,
      },
      {
        specifier: "fs",
        kind: "require",
        external: true,
        line: 2,
      },
    ]);
    expect(entry.exports).toEqual([
      { name: "makeFoo", kind: "commonjs", line: 5 },
      { name: "module.exports", kind: "commonjs", line: 6 },
    ]);
  });

  it("preserves unresolved relative imports without claiming they are external", () => {
    const entry = extract(
      "src/foo.ts",
      'import { missing } from "./missing";\nexport const value = missing;',
    );

    expect(entry.imports).toEqual([
      {
        specifier: "./missing",
        kind: "static",
        imported: ["missing"],
        line: 1,
      },
    ]);
  });

  it("records metadata and language", () => {
    const content = "export const value = 1;";
    const entry = extract("src/foo.ts", content);

    expect(entry.relPath).toBe("src/foo.ts");
    expect(entry.hash).toBe(hashContent(content));
    expect(entry.indexedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(entry.size).toBeGreaterThan(0);
    expect(entry.mtimeMs).toBeGreaterThan(0);
    expect(entry.language).toBe("typescript");
  });
});
