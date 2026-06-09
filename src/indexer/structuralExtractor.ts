import * as fs from "fs";
import * as path from "path";

import type {
  StructuralExport,
  StructuralFileEntry,
  StructuralImport,
  StructuralSymbol,
} from "./structuralGraph.js";

export interface ExtractStructuralFileOptions {
  content: string;
  absPath: string;
  relPath: string;
  workspaceRoot: string;
  hash: string;
  indexedAt?: string;
  size?: number;
  mtimeMs?: number;
}

const SOURCE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];

const INDEX_EXTENSIONS = [
  "index.ts",
  "index.tsx",
  "index.js",
  "index.jsx",
  "index.mjs",
  "index.cjs",
  "index.json",
];

export function extractStructuralFile(
  options: ExtractStructuralFileOptions,
): StructuralFileEntry {
  const language = getLanguage(options.absPath);
  const lines = options.content.split("\n");
  const imports = extractImports(lines, options);
  const exports = extractExports(lines, options);
  const symbols = extractSymbols(lines, exports);

  return {
    relPath: normalizeRelPath(options.relPath),
    hash: options.hash,
    indexedAt: options.indexedAt ?? new Date().toISOString(),
    ...(options.size !== undefined ? { size: options.size } : {}),
    ...(options.mtimeMs !== undefined ? { mtimeMs: options.mtimeMs } : {}),
    ...(language ? { language } : {}),
    imports,
    exports,
    symbols,
  };
}

function extractImports(
  lines: string[],
  options: ExtractStructuralFileOptions,
): StructuralImport[] {
  const imports: StructuralImport[] = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const staticImport = line.match(
      /^\s*import\s+(?:type\s+)?(?:(.+?)\s+from\s+)?["']([^"']+)["']/,
    );
    if (staticImport) {
      const importClause = staticImport[1]?.trim();
      const specifier = staticImport[2];
      imports.push(
        buildImport({
          specifier,
          kind: "static",
          line: lineNumber,
          imported: parseImportedNames(importClause),
          options,
        }),
      );
    }

    const reexport = line.match(
      /^\s*export\s+(?:type\s+)?(?:\*|\{([^}]*)\})\s+from\s+["']([^"']+)["']/,
    );
    if (reexport) {
      const specifier = reexport[2];
      imports.push(
        buildImport({
          specifier,
          kind: "reexport",
          line: lineNumber,
          imported: parseNamedList(reexport[1]),
          options,
        }),
      );
    }

    for (const match of line.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
      imports.push(
        buildImport({
          specifier: match[1],
          kind: "require",
          line: lineNumber,
          options,
        }),
      );
    }

    for (const match of line.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
      imports.push(
        buildImport({
          specifier: match[1],
          kind: "dynamic",
          line: lineNumber,
          options,
        }),
      );
    }
  });

  return dedupeImports(imports);
}

function extractExports(
  lines: string[],
  options: ExtractStructuralFileOptions,
): StructuralExport[] {
  const exports: StructuralExport[] = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    const declaration = line.match(
      /^\s*export\s+(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/,
    );
    if (declaration) {
      exports.push({
        name: declaration[2],
        kind: declaration[1] === "default" ? "default" : "named",
        line: lineNumber,
      });
    }

    const defaultDeclaration = line.match(
      /^\s*export\s+default\s+(?:async\s+)?(?:function|class)?\s*([A-Za-z_$][\w$]*)?/,
    );
    if (defaultDeclaration) {
      exports.push({
        name: defaultDeclaration[1] || "default",
        kind: "default",
        line: lineNumber,
      });
    }

    const namedList = line.match(
      /^\s*export\s+(?:type\s+)?\{([^}]*)\}(?:\s+from\s+["']([^"']+)["'])?/,
    );
    if (namedList) {
      const source = namedList[2];
      const resolved = source ? resolveSpecifier(source, options) : undefined;
      for (const name of parseNamedList(namedList[1])) {
        exports.push({
          name,
          kind: source ? "reexport" : "named",
          ...(source ? { source } : {}),
          ...(resolved ? { resolvedRelPath: resolved } : {}),
          line: lineNumber,
        });
      }
    }

    const starReexport = line.match(
      /^\s*export\s+\*\s+from\s+["']([^"']+)["']/,
    );
    if (starReexport) {
      const source = starReexport[1];
      const resolved = resolveSpecifier(source, options);
      exports.push({
        name: "*",
        kind: "reexport",
        source,
        ...(resolved ? { resolvedRelPath: resolved } : {}),
        line: lineNumber,
      });
    }

    const commonJsDefault = line.match(/^\s*module\.exports\s*=/);
    if (commonJsDefault) {
      exports.push({
        name: "module.exports",
        kind: "commonjs",
        line: lineNumber,
      });
    }

    const commonJsNamed = line.match(/^\s*exports\.([A-Za-z_$][\w$]*)\s*=/);
    if (commonJsNamed) {
      exports.push({
        name: commonJsNamed[1],
        kind: "commonjs",
        line: lineNumber,
      });
    }
  });

  return dedupeExports(exports);
}

function extractSymbols(
  lines: string[],
  exports: StructuralExport[],
): StructuralSymbol[] {
  const exportedNames = new Set(
    exports
      .filter((entry) => entry.name !== "*" && entry.name !== "module.exports")
      .map((entry) => entry.name),
  );
  const symbols: StructuralSymbol[] = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const declaration = line.match(
      /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/,
    );
    if (!declaration) return;

    const kind = declaration[1] as StructuralSymbol["kind"];
    const name = declaration[2];
    symbols.push({
      name,
      kind,
      exported: exportedNames.has(name) || /^\s*export\b/.test(line),
      line: lineNumber,
    });
  });

  return dedupeSymbols(symbols);
}

function buildImport(args: {
  specifier: string;
  kind: StructuralImport["kind"];
  line: number;
  imported?: string[];
  options: ExtractStructuralFileOptions;
}): StructuralImport {
  const resolvedRelPath = resolveSpecifier(args.specifier, args.options);
  const external = !isRelativeSpecifier(args.specifier);
  return {
    specifier: args.specifier,
    kind: args.kind,
    ...(args.imported?.length ? { imported: args.imported } : {}),
    ...(resolvedRelPath ? { resolvedRelPath } : {}),
    ...(external ? { external: true } : {}),
    line: args.line,
  };
}

function parseImportedNames(
  importClause: string | undefined,
): string[] | undefined {
  if (!importClause) return undefined;
  const names = new Set<string>();
  const trimmed = importClause.trim();

  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    names.add("default");
  }

  const namespaceMatch = trimmed.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespaceMatch) names.add("*");

  const namedMatch = trimmed.match(/\{([^}]*)\}/);
  const defaultBeforeNamed = namedMatch
    ? trimmed.slice(0, namedMatch.index).replace(/,\s*$/, "").trim()
    : "";
  if (/^[A-Za-z_$][\w$]*$/.test(defaultBeforeNamed)) {
    names.add("default");
  }
  for (const name of parseNamedList(namedMatch?.[1])) {
    names.add(name);
  }

  return names.size > 0 ? [...names] : undefined;
}

function parseNamedList(list: string | undefined): string[] {
  if (!list) return [];
  return list
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [left, right] = part.split(/\s+as\s+/).map((item) => item.trim());
      return right || left;
    })
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

function resolveSpecifier(
  specifier: string,
  options: ExtractStructuralFileOptions,
): string | undefined {
  if (!isRelativeSpecifier(specifier)) return undefined;

  const sourceDir = path.dirname(options.absPath);
  const candidateBase = path.resolve(sourceDir, specifier);
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = `${candidateBase}${ext}`;
    if (isFile(candidate))
      return toWorkspaceRelPath(candidate, options.workspaceRoot);
  }

  for (const indexFile of INDEX_EXTENSIONS) {
    const candidate = path.join(candidateBase, indexFile);
    if (isFile(candidate))
      return toWorkspaceRelPath(candidate, options.workspaceRoot);
  }

  return undefined;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function toWorkspaceRelPath(absPath: string, workspaceRoot: string): string {
  return normalizeRelPath(path.relative(workspaceRoot, absPath));
}

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}

function getLanguage(absPath: string): string | undefined {
  const ext = path.extname(absPath).toLowerCase();
  switch (ext) {
    case ".ts":
      return "typescript";
    case ".tsx":
      return "typescriptreact";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".jsx":
      return "javascriptreact";
    case ".json":
      return "json";
    default:
      return undefined;
  }
}

function dedupeImports(imports: StructuralImport[]): StructuralImport[] {
  const seen = new Set<string>();
  return imports.filter((entry) => {
    const key = `${entry.kind}:${entry.specifier}:${entry.line}:${entry.imported?.join(",") ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeExports(exports: StructuralExport[]): StructuralExport[] {
  const seen = new Set<string>();
  return exports.filter((entry) => {
    const key = `${entry.kind}:${entry.name}:${entry.source ?? ""}:${entry.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeSymbols(symbols: StructuralSymbol[]): StructuralSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((entry) => {
    const key = `${entry.kind}:${entry.name}:${entry.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
