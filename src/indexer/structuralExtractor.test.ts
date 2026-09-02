import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLineStarts,
  extractStructuralFile,
  getLineNumberAtOffset,
  normalizeStructuralSymbolHints,
  shouldUseTreeSitterSymbolHints,
  STRUCTURAL_EXTRACTOR_VERSION,
  type StructuralExtractorMetrics,
} from "./structuralExtractor.js";

import { hashContent } from "./workerLib.js";

function normalize(entries: unknown): unknown {
  return JSON.parse(JSON.stringify(entries));
}

function createMetrics(): StructuralExtractorMetrics {
  return {
    lineLookupComparisons: 0,
    relativeSpecifiers: 0,
    resolutionCandidateChecks: 0,
    resolvedRelativeSpecifiers: 0,
  };
}

function listSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(entryPath);
    return /\.(?:[cm]?js|jsx|tsx?)$/.test(entry.name) ? [entryPath] : [];
  });
}

describe("line offset index", () => {
  it("maps offsets to lines across empty and trailing-newline content", () => {
    const content = "alpha\n\ngamma\n";
    const starts = buildLineStarts(content.split("\n"));

    expect(starts).toEqual([0, 6, 7, 13]);
    expect(
      [-1, 0, 4, 5, 6, 7, 12, 13, content.length, content.length + 100].map(
        (offset) => getLineNumberAtOffset(starts, offset),
      ),
    ).toEqual([1, 1, 1, 1, 2, 3, 3, 4, 4, 4]);
  });

  it("handles empty content and CRLF offsets", () => {
    expect(getLineNumberAtOffset(buildLineStarts([""]), 0)).toBe(1);

    const content = "one\r\ntwo";
    const starts = buildLineStarts(content.split("\n"));
    expect(starts).toEqual([0, 5]);
    expect(getLineNumberAtOffset(starts, 4)).toBe(1);
    expect(getLineNumberAtOffset(starts, 5)).toBe(2);
  });

  it("keeps pathological million-line lookups logarithmic", () => {
    const lineCount = 1_000_000;
    const starts = Array.from({ length: lineCount }, (_, index) => index * 2);
    const metrics = createMetrics();

    expect(
      [-1, 0, lineCount - 1, starts.at(-1)!, starts.at(-1)! + 100].map(
        (offset) => getLineNumberAtOffset(starts, offset, metrics),
      ),
    ).toEqual([1, 1, 500_000, lineCount, lineCount]);
    expect(metrics.lineLookupComparisons).toBeLessThanOrEqual(100);
  });
});

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

  function extract(
    relPath: string,
    content: string,
    metrics?: StructuralExtractorMetrics,
  ) {
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
      metrics,
    });
  }

  it("rejects mismatched absolute and relative path identities", () => {
    const content = "export const actual = true;";
    const absPath = writeFile("src/actual.ts", content);

    expect(() =>
      extractStructuralFile({
        content,
        absPath,
        relPath: "src/claimed.ts",
        workspaceRoot,
        hash: hashContent(content),
      }),
    ).toThrow("Path does not match its canonical workspace identity");
  });

  it("bounds module-resolution candidate checks", () => {
    writeFile("src/direct.ts", "export const direct = true;");
    writeFile("src/generated.ts", "export const generated = true;");
    writeFile("src/folder/index.ts", "export const folder = true;");
    const metrics = createMetrics();

    const entry = extract(
      "src/candidates.ts",
      [
        'import { direct } from "./direct";',
        'import { generated } from "./generated.js";',
        'import { folder } from "./folder";',
        'import { missing } from "./missing";',
        'import { external } from "external-package";',
      ].join("\n"),
      metrics,
    );

    expect(entry.imports.map((entry) => entry.resolvedRelPath)).toEqual([
      "src/direct.ts",
      "src/generated.ts",
      "src/folder/index.ts",
      undefined,
      undefined,
    ]);
    expect(metrics).toMatchObject({
      relativeSpecifiers: 4,
      resolutionCandidateChecks: 27,
      resolvedRelativeSpecifiers: 3,
    });
    expect(metrics.resolutionCandidateChecks).toBeLessThanOrEqual(
      metrics.relativeSpecifiers * 15,
    );
  });

  it("leaves traversal and symlink escapes unresolved", () => {
    const outsideName = `${path.basename(workspaceRoot)}-outside`;
    const outside = path.join(path.dirname(workspaceRoot), `${outsideName}.ts`);
    try {
      fs.writeFileSync(outside, "export const outside = true;", "utf8");
      const alias = path.join(workspaceRoot, "src", "linked.ts");
      fs.mkdirSync(path.dirname(alias), { recursive: true });
      fs.symlinkSync(outside, alias, "file");

      const entry = extract(
        "src/nested/importer.ts",
        [
          `import { outside } from "../../../${outsideName}";`,
          'import { linked } from "../linked";',
        ].join("\n"),
      );

      expect(entry.imports.map((item) => item.resolvedRelPath)).toEqual([
        undefined,
        undefined,
      ]);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

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

  it("indexes many imports with exact early, middle, and late line numbers", () => {
    const importCount = 10_000;
    const content = Array.from(
      { length: importCount },
      (_, index) => `import value${index} from "package-${index}";`,
    ).join("\n");

    const entry = extract("src/many-imports.ts", content);

    expect(entry.imports).toHaveLength(importCount);
    expect(entry.imports[0]).toEqual(
      expect.objectContaining({ specifier: "package-0", line: 1 }),
    );
    expect(entry.imports[4_999]).toEqual(
      expect.objectContaining({ specifier: "package-4999", line: 5_000 }),
    );
    expect(entry.imports[9_999]).toEqual(
      expect.objectContaining({ specifier: "package-9999", line: 10_000 }),
    );
  });

  it("measures repository module-resolution candidate amplification", () => {
    const repositoryRoot = process.cwd();
    const sourceRoot = path.join(repositoryRoot, "src");
    const metrics = createMetrics();
    const files = listSourceFiles(sourceRoot);

    for (const absPath of files) {
      const content = fs.readFileSync(absPath, "utf8");
      extractStructuralFile({
        content,
        absPath,
        relPath: path.relative(repositoryRoot, absPath),
        workspaceRoot: repositoryRoot,
        hash: hashContent(content),
        metrics,
      });
    }

    expect(files.length).toBeGreaterThan(500);
    expect(metrics.relativeSpecifiers).toBeGreaterThan(0);
    expect(metrics.resolutionCandidateChecks).toBeLessThanOrEqual(
      metrics.relativeSpecifiers * 15,
    );
    expect(metrics.resolvedRelativeSpecifiers).toBeLessThanOrEqual(
      metrics.relativeSpecifiers,
    );
    if (process.env.AGENTLINK_INDEXER_REPORT === "1") {
      process.stdout.write(
        `${JSON.stringify({ structural: { files: files.length, ...metrics } })}\n`,
      );
    }
  }, 15_000);

  it("normalizes parser symbol hints into the stable structural vocabulary", () => {
    expect(
      normalizeStructuralSymbolHints([
        {
          name: "run",
          kind: "method",
          exported: false,
          line: 8,
          scope: ["class Worker", "method run"],
        },
        {
          name: "run",
          kind: "method",
          exported: false,
          line: 9,
          scope: ["class Worker", "method run"],
        },
        { name: "State", kind: "struct", exported: true, line: 2 },
        { name: "Visible", kind: "trait", exported: true, line: 3 },
        { name: "VALUE", kind: "constant", exported: true, line: 4 },
        { name: "namespace", kind: "module", line: 1 },
      ]),
    ).toEqual([
      { name: "run", kind: "function", exported: false, line: 8 },
      { name: "State", kind: "class", exported: true, line: 2 },
      { name: "Visible", kind: "interface", exported: true, line: 3 },
      { name: "VALUE", kind: "const", exported: true, line: 4 },
      { name: "namespace", kind: "unknown", line: 1 },
    ]);
  });

  it("uses parser symbol hints only outside the JavaScript family", () => {
    expect(shouldUseTreeSitterSymbolHints("src/example.py")).toBe(true);
    expect(shouldUseTreeSitterSymbolHints("src/example.java")).toBe(true);
    expect(shouldUseTreeSitterSymbolHints("src/example.ts")).toBe(false);
    expect(shouldUseTreeSitterSymbolHints("src/example.tsx")).toBe(false);
    expect(shouldUseTreeSitterSymbolHints("src/example.js")).toBe(false);
    expect(shouldUseTreeSitterSymbolHints("src/example.jsx")).toBe(false);
    expect(shouldUseTreeSitterSymbolHints("src/example.mjs")).toBe(false);
    expect(shouldUseTreeSitterSymbolHints("src/example.cjs")).toBe(false);
  });

  it("merges non-JavaScript parser symbols but preserves JavaScript extraction", () => {
    const python = extract("src/example.py", "def run():\n    return True");
    const pythonWithHints = extractStructuralFile({
      content: "def run():\n    return True",
      absPath: path.join(workspaceRoot, "src/example.py"),
      relPath: "src/example.py",
      workspaceRoot,
      hash: python.hash,
      symbolHints: [
        { name: "run", kind: "function", exported: false, line: 1 },
      ],
    });
    expect(pythonWithHints.symbols).toEqual([
      { name: "run", kind: "function", exported: false, line: 1 },
    ]);

    const typescriptContent = "export const value = 1;";
    const typescript = extract("src/hints.ts", typescriptContent);
    const ignoredHints = extractStructuralFile({
      content: typescriptContent,
      absPath: path.join(workspaceRoot, "src/hints.ts"),
      relPath: "src/hints.ts",
      workspaceRoot,
      hash: typescript.hash,
      symbolHints: [{ name: "wrong", kind: "class", line: 99 }],
    });
    expect(ignoredHints.symbols).toEqual(typescript.symbols);
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
    expect(entry.extractorVersion).toBe(STRUCTURAL_EXTRACTOR_VERSION);
  });
});
