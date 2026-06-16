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
  getAlCollectionName,
  semanticSearch,
} from "../../services/semanticSearch.js";
import {
  getContextDiagnosticsSummary,
  getContextDocumentSymbols,
  getContextGitStatus,
} from "../../tools/context/getContext.js";
import {
  getStructuralCachePath,
  hashContent,
  loadStructuralCache,
} from "../../indexer/workerLib.js";
import {
  getWorkspaceRootForPath,
  resolveAndValidatePath,
  tryGetFirstWorkspaceRoot,
} from "../../util/paths.js";

import type { ApprovalManager } from "../../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../../approvals/ApprovalPanelProvider.js";
import { WorkingSetStore } from "../../tools/context/WorkingSetStore.js";
import { approveOutsideWorkspaceAccess } from "../../tools/pathAccessUI.js";
import { isAgentlinkTmpArtifact } from "../../util/agentlinkTmpArtifacts.js";
import { resolveAndOpenDocument } from "../../tools/languageFeatures.js";

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

export function createVscodeSemanticSearchProvider(): SemanticSearchProvider {
  return {
    search(params) {
      const dirPath = params.path
        ? resolveAndValidatePath(params.path).absolutePath
        : (tryGetFirstWorkspaceRoot() ?? ".");
      return semanticSearch(
        dirPath,
        params.query,
        params.limit,
        params.exclude_globs,
        { includeAllWorkspaceRoots: !params.path },
      );
    },
  };
}

export function createVscodeContextDocumentProvider(
  approvalManager: ApprovalManager,
  approvalPanel: ApprovalPanelProvider,
): ContextDocumentProvider {
  return {
    async resolveDocument(inputPath, sessionId) {
      const { uri, document, absolutePath, relPath } =
        await resolveAndOpenDocument(
          inputPath,
          approvalManager,
          approvalPanel,
          sessionId,
        );
      return {
        absolutePath,
        relPath,
        languageId: document.languageId,
        hostDocument: { uri, document },
      };
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
): StructuralGraphProvider | undefined {
  if (!globalStorageUri) return undefined;

  return {
    resolveWorkspaceRoot(inputPath) {
      if (!inputPath) return tryGetFirstWorkspaceRoot();
      const { absolutePath, inWorkspace } = resolveAndValidatePath(inputPath);
      if (!inWorkspace) return undefined;
      return getWorkspaceRootForPath(absolutePath);
    },
    resolvePath(inputPath) {
      return resolveAndValidatePath(inputPath);
    },
    getWorkspaceRootForPath,
    loadGraph(workspaceRoot) {
      const collectionName = getAlCollectionName(workspaceRoot);
      const vectorCachePath = path.join(
        globalStorageUri.fsPath,
        "index-cache",
        `${collectionName}.json`,
      );
      const structuralCachePath = getStructuralCachePath(vectorCachePath);
      const graphExists = fs.existsSync(structuralCachePath);
      const graph = loadStructuralCache(structuralCachePath, workspaceRoot);
      return {
        graph,
        workspaceRoot,
        collectionName,
        structuralCachePath,
        graphExists,
      };
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
): PathAccessProvider {
  return {
    async ensureAccess(request) {
      if (request.inWorkspace) {
        return { approved: true };
      }

      if (
        request.allowTemporaryArtifact &&
        isAgentlinkTmpArtifact(request.absolutePath)
      ) {
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
      );
    },
  };
}
