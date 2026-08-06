import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import type * as vscode from "vscode";

import type {
  AdvertisedArtifactProvider,
  ContextDocumentProvider,
  ContextEnrichmentProvider,
  ContextWorkingSetProvider,
  PathAccessProvider,
  ReadFileEnrichmentProvider,
  SemanticSearchProvider,
  StructuralGraphProvider,
  WorkspaceFileProvider,
} from "../../core/capabilities/readSearch.js";
import {
  detectLanguage,
  getDiagnosticsSummary,
  getGitStatus,
  getSymbolOutline,
} from "../../tools/readFile.js";
import {
  getContextDiagnosticsSummary,
  getContextDocumentSymbols,
  getContextGitStatus,
} from "../../tools/context/getContext.js";
import { hashContent } from "../../indexer/workerLib.js";
import {
  getWorkspaceRoots,
  resolveAndValidatePath,
  tryGetFirstWorkspaceRoot,
} from "../../util/paths.js";
import { getCodeIndexWorkspaceRootForPath } from "../../indexer/codeIndexPaths.js";

import type { ApprovalManager } from "../../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../../approvals/ApprovalPanelProvider.js";
import { WorkingSetStore } from "../../tools/context/WorkingSetStore.js";
import {
  approveOutsideWorkspaceAccess,
  type GuardianOutsideReadOptions,
} from "../../tools/pathAccessUI.js";
import {
  getCodeRetrievalStoreRoot,
  getCodeWorkspaceScopeId,
} from "../../indexer/codeRetrievalIdentity.js";
import { createCodeIndexFingerprint } from "../../indexer/retrievalFingerprint.js";
import { projectStructuralRelations } from "../../indexer/structuralRelationProjection.js";
import { isAgentlinkTmpArtifact } from "../../util/agentlinkTmpArtifacts.js";
import { resolveAndOpenDocument } from "../../tools/languageFeatures.js";
import { semanticSearch } from "../../services/semanticSearch.js";
import { LanceDbRetrievalRepository } from "../../storage/retrieval/LanceDbRetrievalRepository.js";

export function createVscodeWorkspaceFileProvider(): WorkspaceFileProvider {
  return {
    resolvePath(inputPath) {
      return resolveAndValidatePath(inputPath);
    },
  };
}

export function createVscodeAdvertisedArtifactProvider(): AdvertisedArtifactProvider {
  return {
    resolvePath(inputPath) {
      return resolveAndValidatePath(inputPath).absolutePath;
    },
    normalizeExistingPath(filePath) {
      try {
        return path.normalize(fs.realpathSync(filePath));
      } catch {
        return path.normalize(path.resolve(filePath));
      }
    },
    readTextFile(filePath) {
      return fsp.readFile(filePath, "utf-8");
    },
  };
}

export function createVscodeReadFileEnrichmentProvider(): ReadFileEnrichmentProvider {
  return {
    getGitStatus,
    detectLanguage,
    getSymbolOutline,
    getDiagnosticsSummary,
  };
}

export function createVscodeSemanticSearchProvider(
  projectRoot?: string,
  globalStorageUri?: vscode.Uri,
): SemanticSearchProvider {
  return {
    async search(params) {
      const dirPath = params.path
        ? resolveAndValidatePath(params.path).absolutePath
        : (projectRoot ?? tryGetFirstWorkspaceRoot() ?? ".");
      const result = await semanticSearch(
        dirPath,
        params.query,
        params.limit,
        params.exclude_globs,
        {
          includeAllWorkspaceRoots: false,
          ...(globalStorageUri
            ? {
                retrievalStoreRootForWorkspace: (workspaceRoot: string) =>
                  getCodeRetrievalStoreRoot(
                    globalStorageUri.fsPath,
                    workspaceRoot,
                  ),
              }
            : {}),
        },
      );
      return {
        payload: readSemanticSearchPayload(result),
        ...(result.isError ? { isError: true } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    },
  };
}

function readSemanticSearchPayload(result: {
  data?: unknown;
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  if (isRecord(result.data)) return result.data;
  const text = result.content.find((entry) => entry.type === "text")?.text;
  if (text === undefined) {
    throw new Error("Semantic search returned no JSON payload");
  }
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Semantic search returned a malformed JSON payload");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createVscodeContextDocumentProvider(
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  signal?: AbortSignal,
): ContextDocumentProvider {
  return {
    async resolveDocument(inputPath, sessionId) {
      try {
        const { uri, document, absolutePath, relPath } =
          await resolveAndOpenDocument(
            inputPath,
            approvalManager,
            approvalPanel,
            sessionId,
            signal,
          );
        return {
          absolutePath,
          relPath,
          languageId: document.languageId,
          hostDocument: { uri, document },
        };
      } catch (err) {
        // VS Code's openTextDocument missing-file error has no stable error code.
        // Keep this host-specific message coupling at the adapter boundary.
        if (
          err instanceof Error &&
          err.message.includes("Unable to resolve nonexistent file")
        ) {
          throw Object.assign(new Error(err.message), { code: "FileNotFound" });
        }
        throw err;
      }
    },
  };
}

const contextWorkingSetStore = new WorkingSetStore();

export function createVscodeContextWorkingSetProvider(): ContextWorkingSetProvider {
  return {
    check(request) {
      return contextWorkingSetStore.check(request);
    },
  };
}

export function createVscodeContextEnrichmentProvider(): ContextEnrichmentProvider {
  return {
    getGitStatus: getContextGitStatus,
    getDocumentSymbols: getContextDocumentSymbols,
    getDiagnosticsSummary: getContextDiagnosticsSummary,
  };
}

export function createVscodeStructuralGraphProvider(
  globalStorageUri: vscode.Uri | undefined,
  chunkGranularity: "standard" | "fine" = "fine",
): StructuralGraphProvider | undefined {
  if (!globalStorageUri) return undefined;

  const getOwningWorkspaceRoot = (absolutePath: string) =>
    getCodeIndexWorkspaceRootForPath(getWorkspaceRoots(), absolutePath);

  return {
    resolveWorkspaceRoot(inputPath) {
      if (!inputPath) return tryGetFirstWorkspaceRoot();
      const { absolutePath, inWorkspace } = resolveAndValidatePath(inputPath);
      if (!inWorkspace) return undefined;
      return getOwningWorkspaceRoot(absolutePath);
    },
    resolvePath(inputPath) {
      return resolveAndValidatePath(inputPath);
    },
    getWorkspaceRootForPath: getOwningWorkspaceRoot,
    getScopeStatus(absolutePath, matchedFiles) {
      if (matchedFiles > 0) return "indexed";
      try {
        return fs.statSync(absolutePath).isDirectory()
          ? "unindexed"
          : "unindexed_file";
      } catch {
        return "missing";
      }
    },
    async loadGraph(workspaceRoot) {
      const indexName = getCodeWorkspaceScopeId(workspaceRoot);
      const structuralCachePath = getCodeRetrievalStoreRoot(
        globalStorageUri.fsPath,
        workspaceRoot,
      );
      const storeExists = fs.existsSync(structuralCachePath);
      if (!storeExists) {
        return {
          graph: projectStructuralRelations({
            workspaceRoot,
            indexName,
            sources: [],
            relations: [],
          }),
          workspaceRoot,
          indexName,
          structuralStorePath: structuralCachePath,
          graphExists: false,
        };
      }

      const repository = new LanceDbRetrievalRepository({
        root: structuralCachePath,
      });
      try {
        const snapshot = await repository.structuralSnapshot({
          expectedFingerprint: createCodeIndexFingerprint(chunkGranularity),
          filters: {
            namespaces: ["code"],
            sourceKinds: ["file"],
            metadata: { scopeId: indexName },
          },
        });
        return {
          graph: projectStructuralRelations({
            workspaceRoot,
            indexName,
            sources: snapshot.sources,
            relations: snapshot.relations,
          }),
          workspaceRoot,
          indexName,
          structuralStorePath: structuralCachePath,
          graphExists: snapshot.status === "ready",
        };
      } finally {
        await repository.close();
      }
    },
    getTargetFreshness(absolutePath, target) {
      if (!target) {
        return { status: "missing_from_graph" };
      }

      try {
        const stat = fs.statSync(absolutePath);
        if (!stat.isFile()) {
          return { status: "target_not_file", indexed_at: target.indexedAt };
        }
        const content = fs.readFileSync(absolutePath, "utf-8");
        const currentHash = hashContent(content);
        const status = currentHash === target.hash ? "fresh" : "stale";
        return {
          status,
          indexed_at: target.indexedAt,
          indexed_hash: target.hash,
          current_hash: currentHash,
          size: stat.size,
          mtime_ms: stat.mtimeMs,
        };
      } catch {
        return { status: "target_missing", indexed_at: target.indexedAt };
      }
    },
  };
}

export function createVscodePathAccessProvider(
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
  signal?: AbortSignal,
  guardian?: GuardianOutsideReadOptions,
): PathAccessProvider {
  return {
    async ensureAccess(request) {
      if (request.inWorkspace) {
        return { approved: true };
      }

      if (isAgentlinkTmpArtifact(request.absolutePath)) {
        return { approved: true };
      }

      if (
        approvalManager.isPathTrusted(request.sessionId, request.absolutePath)
      ) {
        return { approved: true };
      }

      return approveOutsideWorkspaceAccess(
        request.absolutePath,
        approvalManager,
        approvalPanel,
        request.sessionId,
        signal,
        ...(guardian ? [guardian] : []),
      );
    },
  };
}
