import * as path from "path";

import { canonicalizePath } from "../util/canonicalPath.js";
import { createHash } from "crypto";
import { requireCanonicalPortableCodeIndexPath } from "./codeIndexPaths.js";

export const CODE_INDEX_STORAGE_GENERATION = 3;
export const CODE_RETRIEVAL_STORES_DIRECTORY = `code-indexes-v${CODE_INDEX_STORAGE_GENERATION}`;

export function getCodeWorkspaceScopeId(workspaceRoot: string): string {
  const canonicalRoot = canonicalizePath(workspaceRoot);
  const hash = createHash("sha256").update(canonicalRoot).digest("hex");
  return `workspace:${hash.slice(0, 24)}`;
}

export function getCodeIndexCacheKey(workspaceRoot: string): string {
  const workspaceHash = getCodeWorkspaceScopeId(workspaceRoot).slice(
    "workspace:".length,
  );
  return `al-v${CODE_INDEX_STORAGE_GENERATION}-${workspaceHash.slice(0, 16)}`;
}

export function getCodeRetrievalStoreRoot(
  globalStoragePath: string,
  workspaceRoot: string,
): string {
  return path.join(
    globalStoragePath,
    CODE_RETRIEVAL_STORES_DIRECTORY,
    getCodeWorkspaceScopeId(workspaceRoot).replace(":", "-"),
  );
}

export function getCodeSourceId(
  workspaceScopeId: string,
  sourcePath: string,
): string {
  const canonicalPath = requireCanonicalPortableCodeIndexPath(sourcePath);
  return `code:${workspaceScopeId}:${canonicalPath}`;
}

export function getCodeSymbolId(
  sourceId: string,
  symbolKind: string,
  symbolName: string,
): string {
  return `symbol:${sourceId}:${encodeURIComponent(symbolKind)}:${encodeURIComponent(symbolName)}`;
}

export function getCodeExternalModuleId(specifier: string): string {
  return `external-module:${encodeURIComponent(specifier)}`;
}

export function getCodeRelationId(input: {
  sourceId: string;
  revisionId: string;
  generation: string;
  kind: string;
  fromId: string;
  toId: string;
  ordinal: number;
}): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        input.sourceId,
        input.revisionId,
        input.generation,
        input.kind,
        input.fromId,
        input.toId,
        input.ordinal,
      ]),
    )
    .digest("hex");
  return `relation:${hash}`;
}
