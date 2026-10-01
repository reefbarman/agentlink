import * as vscode from "vscode";
import * as path from "path";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { readFile, stat } from "fs/promises";
import picomatch from "picomatch";

import {
  openAiCodexAuthManager,
  type OpenAiCodexResolvedAuth,
} from "../agent/providers/index.js";
import { getWorkspaceRootForPath, getWorkspaceRoots } from "../util/paths.js";
import {
  execRipgrepSearch,
  getRipgrepBinPath,
  parseRipgrepOutput,
  truncateLine,
} from "../util/ripgrep.js";
import { requestEmbeddings } from "../indexer/embeddingClient.js";
import { resolveContainedCodeIndexPath } from "../indexer/codeIndexPaths.js";
import {
  isStructuredConfigPath,
  redactStructuredSecrets,
} from "../shared/structuredSecretRedaction.js";
import {
  getCodeSourceId,
  getCodeWorkspaceScopeId,
} from "../indexer/codeRetrievalIdentity.js";
import type { RetrievalHealthReason } from "@agentlink/protocol/retrieval-health";
import { LanceDbRetrievalRepository } from "../storage/retrieval/LanceDbRetrievalRepository.js";
import { canonicalizePath } from "../util/canonicalPath.js";

import { errorResult, type ToolResult } from "@agentlink/protocol/tool-result";
import { getSemanticReadinessMessage } from "@agentlink/protocol/semantic-readiness";
import {
  expandQuery,
  extractAdjacentPhrases,
  extractKeywords,
} from "./semanticQueryEnhancement.js";

export { expandQuery, extractKeywords } from "./semanticQueryEnhancement.js";

// --- Configuration helpers (exported for IndexerManager) ---

function semanticConfiguration(
  workspacePath?: string,
): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(
    "agentlink",
    workspacePath ? vscode.Uri.file(workspacePath) : undefined,
  );
}

const EMBEDDING_MAX_RETRIES = 3;

export async function getEmbeddingAuth(): Promise<OpenAiCodexResolvedAuth | null> {
  return openAiCodexAuthManager.resolveEmbeddingAuth();
}

function isRetryableEmbeddingStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function isSemanticSearchEnabled(workspacePath?: string): boolean {
  return semanticConfiguration(workspacePath).get<boolean>(
    "semanticSearchEnabled",
    true,
  );
}

function isSemanticEmbeddingsEnabled(workspacePath?: string): boolean {
  return semanticConfiguration(workspacePath).get<boolean>(
    "semanticEmbeddingsEnabled",
    false,
  );
}

function semanticErrorPayload(
  reason:
    | "disabled"
    | "missing_embeddings_auth"
    | "no_workspace"
    | "missing_index"
    | "store_unavailable"
    | "generic_error",
  options?: { detail?: string },
): Record<string, unknown> {
  const message = getSemanticReadinessMessage(reason);
  return {
    error: options?.detail ?? message,
    reason,
    readiness_message: message,
    next_steps:
      reason === "disabled"
        ? [
            "Set agentlink.semanticSearchEnabled to true in settings.",
            "Run 'AgentLink: Set Up Semantic Search' for guided setup.",
          ]
        : reason === "missing_embeddings_auth"
          ? [
              "Run 'AgentLink: Set OpenAI API Key for Embeddings'.",
              "Or run 'AgentLink: Set Up Semantic Search' and choose API-key setup.",
            ]
          : reason === "no_workspace"
            ? ["Open a workspace folder and retry semantic search."]
            : reason === "missing_index"
              ? [
                  "Run 'AgentLink: Rebuild Codebase Index'.",
                  "Or click 'Index Codebase' in the AgentLink sidebar.",
                ]
              : reason === "store_unavailable"
                ? [
                    "Check AgentLink output logs and retry semantic search.",
                    "Rebuild the codebase index if the local retrieval store is damaged.",
                  ]
                : [
                    "Retry semantic search after resolving the underlying error.",
                  ],
  };
}

function classifySemanticReasonFromError(
  message: string,
): "missing_index" | "store_unavailable" | undefined {
  if (/No codebase index found/i.test(message)) return "missing_index";
  if (/retrieval store (?:is )?unavailable/i.test(message)) {
    return "store_unavailable";
  }
  return undefined;
}

function getWorkspaceRootsForSemanticQuery(
  dirPath: string,
  options?: { includeAllWorkspaceRoots?: boolean; exactFile?: boolean },
): SemanticQueryTarget[] {
  const roots = getWorkspaceRoots();
  if (roots.length === 0) return [];

  if (options?.includeAllWorkspaceRoots) {
    return roots.map((workspacePath) => ({ workspacePath }));
  }

  const queryRoot = getWorkspaceRootForPath(dirPath);
  if (!queryRoot) return [];

  return [
    {
      workspacePath: queryRoot,
      directoryPrefix: getDirectoryPrefix(queryRoot, dirPath),
      scope: {
        absolutePath: dirPath,
        kind: options?.exactFile ? "file" : "directory",
      },
    },
  ];
}

function getDirectoryPrefix(
  workspacePath: string,
  dirPath: string,
): string | undefined {
  const relativeDir = path.relative(workspacePath, dirPath).replace(/\\/g, "/");
  return relativeDir === "" ? undefined : relativeDir;
}

function prefixResultPaths(
  results: SemanticSearchRecord[],
  workspacePath: string,
  allWorkspaceRoots: string[],
): SemanticSearchRecord[] {
  if (allWorkspaceRoots.length <= 1) return results;

  const folder = vscode.workspace.getWorkspaceFolder(
    vscode.Uri.file(workspacePath),
  );
  const prefix = folder?.name;
  if (!prefix) return results;

  return results.map((result) => {
    const payload = result.payload;
    const filePath = payload?.filePath;
    if (
      !payload ||
      !filePath ||
      filePath === prefix ||
      filePath.startsWith(`${prefix}/`)
    ) {
      return result;
    }

    return {
      ...result,
      payload: {
        ...payload,
        filePath: `${prefix}/${filePath}`,
      },
    };
  });
}

// --- OpenAI Embeddings via fetch ---

async function generateEmbedding(
  text: string,
  auth: OpenAiCodexResolvedAuth,
): Promise<number[]> {
  const [embedding] = await requestEmbeddings(text, auth.bearerToken, {
    maxRetries: EMBEDDING_MAX_RETRIES,
    retryFetchErrors: true,
    shouldRetryStatus: isRetryableEmbeddingStatus,
    retryDelayMs: (attempt, random, retryAfterMs) =>
      Math.min(retryAfterMs ?? 500 * 2 ** attempt + random * 250, 5_000),
  });
  if (!embedding) {
    throw new Error("OpenAI API returned no embedding data");
  }
  return embedding;
}

// --- Semantic result compatibility shape ---

interface SemanticSearchPayload {
  filePath: string;
  codeChunk: string;
  startLine: number;
  endLine: number;
  sourceRevision?: string;
  type?: string;
}

interface SemanticSearchRecord {
  id: string | number;
  score: number;
  payload?: SemanticSearchPayload;
}

export interface SemanticQueryOptions {
  retrievalStoreRoot?: string;
  retrievalStoreRootForWorkspace?: (
    workspacePath: string,
  ) => string | undefined;
}

interface SemanticQueryTarget {
  workspacePath: string;
  directoryPrefix?: string;
  scope?: {
    absolutePath: string;
    kind: "file" | "directory";
  };
}

export interface SemanticFreshnessSummary {
  stale_sources: string[];
  deleted_sources: string[];
  unverified_sources: string[];
}

interface ValidatedSemanticResults {
  results: SemanticSearchRecord[];
  freshness: SemanticFreshnessSummary;
}

// --- Hybrid search helpers ---

/**
 * Reciprocal Rank Fusion: merge results from multiple retrieval strategies.
 * Items appearing in multiple lists get boosted scores.
 */
export function rrfMerge(
  vectorResults: SemanticSearchRecord[],
  keywordResults: SemanticSearchRecord[],
  limit: number,
  k: number = 60,
): SemanticSearchRecord[] {
  const scores = new Map<
    string,
    { score: number; result: SemanticSearchRecord }
  >();

  vectorResults.forEach((r, rank) => {
    const id = String(r.id);
    const rrfScore = 1 / (k + rank + 1);
    scores.set(id, { score: rrfScore, result: r });
  });

  keywordResults.forEach((r, rank) => {
    const id = String(r.id);
    const rrfScore = 1 / (k + rank + 1);
    const existing = scores.get(id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(id, { score: rrfScore, result: r });
    }
  });

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ result }) => result);
}

/**
 * Rescore results using multiple signals: vector similarity, keyword overlap, path relevance.
 */
function normalizeSemanticResultPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function isExcludedSemanticResultPath(filePath: string): boolean {
  const normalized = normalizeSemanticResultPath(filePath).toLowerCase();
  const withLeadingSlash = normalized.startsWith("/")
    ? normalized
    : `/${normalized}`;
  return (
    withLeadingSlash.includes("/.agentlink/history/") ||
    withLeadingSlash.includes("/.agentlink/workspaces/") ||
    withLeadingSlash.includes("/.agentlink/debug/") ||
    withLeadingSlash.includes("/.agentlink/transcripts/") ||
    withLeadingSlash.includes("/.agentlink/checkpoints/")
  );
}

function applySemanticResultExcludes(
  results: SemanticSearchRecord[],
  excludeGlobs?: string[],
): SemanticSearchRecord[] {
  if (!excludeGlobs || excludeGlobs.length === 0) {
    return results;
  }

  const matchers = excludeGlobs.map((pattern) =>
    picomatch(pattern, { dot: true }),
  );
  return results.filter((result) => {
    const filePath = result.payload?.filePath;
    if (!filePath) return true;
    const normalized = normalizeSemanticResultPath(filePath);
    return !matchers.some((matcher) => matcher(normalized));
  });
}

export function rerankResults(
  results: SemanticSearchRecord[],
  queryKeywords: string[],
  excludeGlobs?: string[],
  queryText?: string,
): SemanticSearchRecord[] {
  const filtered = applySemanticResultExcludes(
    results.filter(
      (r) => !isExcludedSemanticResultPath(r.payload?.filePath ?? ""),
    ),
    excludeGlobs,
  );

  if (queryKeywords.length === 0) return filtered;

  return filtered
    .map((r) => {
      const chunk = (r.payload?.codeChunk ?? "").toLowerCase();
      const filePath = (r.payload?.filePath ?? "").toLowerCase();

      // Signal 1: Vector similarity (already in r.score)
      const vectorScore = r.score;

      // Signal 2: Keyword overlap — fraction of query keywords appearing in chunk
      const keywordHits = queryKeywords.filter((kw) =>
        chunk.includes(kw.toLowerCase()),
      ).length;
      const keywordScore = keywordHits / queryKeywords.length;

      // Signal 3: File path relevance — do query terms appear in file path
      const pathHits = queryKeywords.filter((kw) =>
        filePath.includes(kw.toLowerCase()),
      ).length;
      const pathScore = pathHits / queryKeywords.length;

      // Weighted combination
      const finalScore =
        vectorScore * 0.6 +
        keywordScore * 0.25 +
        pathScore * 0.15 +
        (queryText
          ? queryMatchBonus(`${filePath}\n${chunk}`, queryText) / 1000
          : 0);

      return {
        ...r,
        score:
          finalScore *
          (queryText && isSnapshotOrFixturePath(filePath) ? 0.65 : 1),
      };
    })
    .sort((a, b) => b.score - a.score);
}

// --- Retrieval store query adapter ---

function resolveRetrievalStoreRoot(
  options: SemanticQueryOptions,
  workspacePath: string,
): string | undefined {
  return (
    options.retrievalStoreRoot ??
    options.retrievalStoreRootForWorkspace?.(workspacePath)
  );
}

async function queryRetrievalStore(args: {
  retrievalStoreRoot: string | undefined;
  workspacePath: string;
  queryText: string;
  queryVector?: number[];
  directoryPrefix?: string;
  exactFile?: boolean;
  limit: number;
  excludeGlobs?: string[];
}): Promise<{
  records: SemanticSearchRecord[];
  mode: string;
  degradedReason?: RetrievalHealthReason;
}> {
  if (!args.retrievalStoreRoot) {
    throw new Error(
      "Retrieval store is unavailable: storage root was not provided",
    );
  }
  if (!existsSync(args.retrievalStoreRoot)) {
    throw new Error("No codebase index found in the local retrieval store");
  }

  const repository = new LanceDbRetrievalRepository({
    root: args.retrievalStoreRoot,
  });
  try {
    const workspaceScopeId = getCodeWorkspaceScopeId(args.workspacePath);
    const normalizedPrefix = args.directoryPrefix
      ? normalizeSemanticResultPath(args.directoryPrefix)
      : undefined;
    const result = await repository.query({
      text: args.queryText,
      ...(args.queryVector ? { embedding: args.queryVector } : {}),
      mode: args.queryVector ? "hybrid" : "lexical",
      filters: {
        namespaces: ["code"],
        sourceKinds: ["file"],
        metadata: {
          scopeId: workspaceScopeId,
        },
        ...(normalizedPrefix
          ? args.exactFile
            ? {
                sourceIds: [
                  getCodeSourceId(workspaceScopeId, normalizedPrefix),
                ],
              }
            : { pathPrefix: normalizedPrefix }
          : {}),
      },
      limit: Math.max(args.limit * 5, 20),
      freshness: "index_only",
      diversity: {
        maxPerSource: Math.max(args.limit, 3),
        collapseOverlaps: true,
      },
    });
    if (isUnavailableRetrievalReason(result.degradedReason)) {
      throw new Error(
        `Retrieval store is unavailable: ${result.degradedReason}`,
      );
    }

    const records = result.candidates.map((candidate) => ({
      id: candidate.chunk.id,
      score: candidate.scores.final,
      payload: {
        filePath: candidate.chunk.location?.path ?? candidate.source.path ?? "",
        codeChunk: candidate.chunk.content,
        startLine: candidate.chunk.location?.startLine ?? 1,
        endLine: candidate.chunk.location?.endLine ?? 1,
        sourceRevision: candidate.source.revision.id,
      },
    }));
    return {
      records: rerankResults(
        records,
        extractKeywords(args.queryText),
        args.excludeGlobs,
        args.queryText,
      ),
      mode: result.mode,
      ...(result.degradedReason
        ? { degradedReason: result.degradedReason }
        : {}),
    };
  } finally {
    await repository.close();
  }
}

function classifyRankingReason(reason: string | undefined): RankingReason {
  switch (reason) {
    case "missing_embeddings_auth":
      return "embedding_auth_missing";
    case "vector_index_unavailable":
    case "missing_index":
    case "store_unavailable":
    case "repair_required":
    case "rebuild_required":
    case "lexical_index_unavailable":
    case "scalar_index_unavailable":
      return reason;
    default:
      return "unknown";
  }
}

function embeddingFailureReason(message: string): RankingReason {
  const status = message.match(/OpenAI API error \((\d{3})\):/i)?.[1];
  if (status) return `embedding_http_${status.startsWith("5") ? "5xx" : "4xx"}`;
  if (
    /\b(fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timeout)\b/i.test(
      message,
    )
  ) {
    return "embedding_network";
  }
  return "unknown";
}

function rankingGuidance(reason: RankingReason): string | undefined {
  switch (reason) {
    case "embedding_auth_missing":
      return "Configure embedding credentials to enable hybrid ranking, or keep embeddings disabled for local lexical search.";
    case "embedding_http_4xx":
    case "embedding_http_5xx":
    case "embedding_network":
      return "Check embedding service availability and credentials, then retry; lexical results were used in the meantime.";
    case "vector_index_unavailable":
      return "Rebuild the codebase index with vector embeddings enabled to restore hybrid ranking.";
    case "missing_index":
    case "rebuild_required":
      return "Rebuild the codebase index, then retry the search.";
    case "repair_required":
    case "store_unavailable":
    case "lexical_index_unavailable":
    case "scalar_index_unavailable":
      return "Check AgentLink output logs and rebuild or repair the local codebase index.";
    case "unknown":
      return "Check AgentLink output logs and embedding configuration if hybrid ranking is expected.";
    default:
      return undefined;
  }
}

function isUnavailableRetrievalReason(
  reason: RetrievalHealthReason | undefined,
): boolean {
  return (
    reason === "missing_index" ||
    reason === "store_unavailable" ||
    reason === "repair_required" ||
    reason === "rebuild_required" ||
    reason === "lexical_index_unavailable" ||
    reason === "scalar_index_unavailable"
  );
}

// --- Result formatting ---

export const MAX_SEARCH_EXCERPT_CHARS = 4000;

interface FormattedResult {
  file: string;
  score: number;
  startLine: number;
  endLine: number;
  codeChunk: string;
}

type RankingReason =
  | "embeddings_disabled"
  | "embedding_auth_missing"
  | `embedding_http_${"4xx" | "5xx"}`
  | "embedding_network"
  | "vector_index_unavailable"
  | "missing_index"
  | "store_unavailable"
  | "repair_required"
  | "rebuild_required"
  | "lexical_index_unavailable"
  | "scalar_index_unavailable"
  | "unknown";

interface BuildOutputOptions {
  ranking: "hybrid" | "lexical" | "keyword_fallback";
  rankingReason?: RankingReason;
  guidance?: string;
  warning?: string;
  freshness?: SemanticFreshnessSummary;
}

function formatResults(results: SemanticSearchRecord[]): FormattedResult[] {
  return results
    .filter(
      (r) =>
        r.payload?.filePath &&
        !isExcludedSemanticResultPath(r.payload.filePath ?? ""),
    )
    .map((r) => ({
      file: r.payload!.filePath,
      score: r.score,
      startLine: r.payload!.startLine,
      endLine: r.payload!.endLine,
      codeChunk: r.payload!.codeChunk?.trim() ?? "",
    }));
}

function buildOutput(
  query: string,
  results: FormattedResult[],
  options: BuildOutputOptions,
): ToolResult {
  const sections = results.map((r) => {
    return `## ${r.file} (score: ${r.score.toFixed(4)}, lines ${r.startLine}-${r.endLine})\n${truncateLine(r.codeChunk, MAX_SEARCH_EXCERPT_CHARS)}`;
  });

  const output: Record<string, unknown> = {
    query,
    ranking: options.ranking,
    ...(options.rankingReason ? { ranking_reason: options.rankingReason } : {}),
    ...(options.guidance ? { guidance: options.guidance } : {}),
    total_results: results.length,
    results: sections.join("\n\n"),
    ...(results.some(
      (result) => result.codeChunk.length > MAX_SEARCH_EXCERPT_CHARS,
    ) && {
      truncated_results: results.filter(
        (result) => result.codeChunk.length > MAX_SEARCH_EXCERPT_CHARS,
      ).length,
      excerpt_limit: MAX_SEARCH_EXCERPT_CHARS,
    }),
  };

  if (options.warning) {
    output.warning = options.warning;
  }
  if (options.freshness && hasFreshnessIssues(options.freshness)) {
    output.freshness = options.freshness;
  }

  return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
}

async function validateSemanticResults(
  results: SemanticSearchRecord[],
  target: SemanticQueryTarget,
  options: { hydrateChunks: boolean },
): Promise<ValidatedSemanticResults> {
  const freshness = emptyFreshnessSummary();
  const sourceStates = new Map<
    string,
    | { status: "current"; content: string }
    | { status: "stale" | "deleted" | "unverified" }
  >();
  const validated: SemanticSearchRecord[] = [];

  for (const result of results) {
    const payload = result.payload;
    if (!payload?.filePath) continue;

    const key = `${payload.filePath}\0${payload.sourceRevision ?? ""}`;
    let state = sourceStates.get(key);
    if (!state) {
      state = await readSemanticSourceState(target, payload);
      sourceStates.set(key, state);
    }
    recordFreshness(freshness, payload.filePath, state.status);

    if (state.status !== "current") continue;
    if (!options.hydrateChunks) {
      validated.push(result);
      continue;
    }

    if (
      !Number.isInteger(payload.startLine) ||
      !Number.isInteger(payload.endLine) ||
      payload.startLine < 1 ||
      payload.endLine < payload.startLine
    ) {
      addUnique(freshness.unverified_sources, payload.filePath);
      continue;
    }
    const lines = state.content.split("\n");
    if (payload.startLine > lines.length) {
      addUnique(freshness.unverified_sources, payload.filePath);
      continue;
    }
    const endLine = Math.min(payload.endLine, lines.length);
    validated.push({
      ...result,
      payload: {
        ...payload,
        endLine,
        codeChunk: lines.slice(payload.startLine - 1, endLine).join("\n"),
      },
    });
  }

  return { results: validated, freshness: dedupeFreshnessSummary(freshness) };
}

async function readSemanticSourceState(
  target: SemanticQueryTarget,
  payload: SemanticSearchPayload,
): Promise<
  | { status: "current"; content: string }
  | { status: "stale" | "deleted" | "unverified" }
> {
  if (!payload.sourceRevision) return { status: "unverified" };
  const identity = resolveContainedCodeIndexPath(
    target.workspacePath,
    path.resolve(target.workspacePath, payload.filePath),
  );
  if (
    !identity ||
    identity.portableRelativePath !== payload.filePath ||
    !isWithinSemanticScope(identity.absolutePath, target.scope)
  ) {
    return { status: "unverified" };
  }

  try {
    const preReadStat = await stat(identity.absolutePath);
    if (!preReadStat.isFile()) return { status: "unverified" };
    const content = await readFile(identity.absolutePath, "utf8");
    const postReadStat = await stat(identity.absolutePath);
    const finalIdentity = resolveContainedCodeIndexPath(
      target.workspacePath,
      identity.absolutePath,
    );
    if (
      !finalIdentity ||
      finalIdentity.absolutePath !== identity.absolutePath ||
      !sameStableSourceStat(preReadStat, postReadStat)
    ) {
      return { status: "unverified" };
    }
    const revision = createHash("sha256").update(content).digest("hex");
    return revision === payload.sourceRevision
      ? {
          status: "current",
          content: redactStructuredSecrets(identity.absolutePath, content)
            .content,
        }
      : { status: "stale" };
  } catch (error) {
    return isMissingSourceError(error)
      ? { status: "deleted" }
      : { status: "unverified" };
  }
}

function isWithinSemanticScope(
  candidatePath: string,
  scope: SemanticQueryTarget["scope"],
): boolean {
  if (!scope) return true;
  const scopePath = canonicalizePath(scope.absolutePath);
  if (scope.kind === "file") return candidatePath === scopePath;
  const relativePath = path.relative(scopePath, candidatePath);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function sameStableSourceStat(
  before: Awaited<ReturnType<typeof stat>>,
  after: Awaited<ReturnType<typeof stat>>,
): boolean {
  return (
    before.isFile() &&
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function recordFreshness(
  freshness: SemanticFreshnessSummary,
  filePath: string,
  status: "current" | "stale" | "deleted" | "unverified",
): void {
  if (status === "stale") addUnique(freshness.stale_sources, filePath);
  else if (status === "deleted") addUnique(freshness.deleted_sources, filePath);
  else if (status === "unverified") {
    addUnique(freshness.unverified_sources, filePath);
  }
}

function isMissingSourceError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return code === "ENOENT" || code === "FileNotFound";
}

function emptyFreshnessSummary(): SemanticFreshnessSummary {
  return { stale_sources: [], deleted_sources: [], unverified_sources: [] };
}

function mergeFreshnessSummaries(
  summaries: SemanticFreshnessSummary[],
): SemanticFreshnessSummary {
  return dedupeFreshnessSummary({
    stale_sources: summaries.flatMap((summary) => summary.stale_sources),
    deleted_sources: summaries.flatMap((summary) => summary.deleted_sources),
    unverified_sources: summaries.flatMap(
      (summary) => summary.unverified_sources,
    ),
  });
}

function prefixFreshnessPaths(
  freshness: SemanticFreshnessSummary,
  workspacePath: string,
  allWorkspaceRoots: string[],
): SemanticFreshnessSummary {
  if (allWorkspaceRoots.length <= 1) return freshness;
  const folder = vscode.workspace.getWorkspaceFolder(
    vscode.Uri.file(workspacePath),
  );
  const prefix = folder?.name;
  if (!prefix) return freshness;
  const applyPrefix = (filePath: string) => `${prefix}/${filePath}`;
  return {
    stale_sources: freshness.stale_sources.map(applyPrefix),
    deleted_sources: freshness.deleted_sources.map(applyPrefix),
    unverified_sources: freshness.unverified_sources.map(applyPrefix),
  };
}

function dedupeFreshnessSummary(
  freshness: SemanticFreshnessSummary,
): SemanticFreshnessSummary {
  return {
    stale_sources: [...new Set(freshness.stale_sources)].sort(),
    deleted_sources: [...new Set(freshness.deleted_sources)].sort(),
    unverified_sources: [...new Set(freshness.unverified_sources)].sort(),
  };
}

function hasFreshnessIssues(freshness: SemanticFreshnessSummary): boolean {
  return (
    freshness.stale_sources.length > 0 ||
    freshness.deleted_sources.length > 0 ||
    freshness.unverified_sources.length > 0
  );
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function escapeRegexLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldFallbackToKeywordSearch(message: string): boolean {
  return (
    /OpenAI API error \((408|429|5\d\d)\):/i.test(message) ||
    /\b(fetch failed|network|ECONN|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timeout)\b/i.test(
      message,
    ) ||
    /retrieval store (?:is )?unavailable/i.test(message) ||
    /No codebase index found/i.test(message)
  );
}

function summarizeSemanticFailure(message: string): string {
  const openAiStatus = message.match(/OpenAI API error \((\d+)\):/i)?.[1];
  if (openAiStatus) {
    return `OpenAI embeddings failed with HTTP ${openAiStatus}`;
  }

  if (
    /\b(fetch failed|network|ECONN|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timeout)\b/i.test(
      message,
    )
  ) {
    return "a network error interrupted semantic search";
  }
  return "semantic search failed";
}

function normalizeFallbackResultPath(
  filePath: string,
  workspacePath: string,
  dirPath: string,
): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (!path.isAbsolute(filePath)) {
    return normalized.startsWith("./") ? normalized.slice(2) : normalized;
  }

  const workspaceRelative = path.relative(workspacePath, filePath);
  if (
    !workspaceRelative.startsWith("..") &&
    !path.isAbsolute(workspaceRelative)
  ) {
    return workspaceRelative.replace(/\\/g, "/");
  }

  const dirRelative = path.relative(dirPath, filePath);
  if (!dirRelative.startsWith("..") && !path.isAbsolute(dirRelative)) {
    return dirRelative.replace(/\\/g, "/");
  }

  return normalized;
}

function isSnapshotOrFixturePath(filePath: string): boolean {
  return (
    /(?:^|\/)(?:__snapshots__|snapshots?|__fixtures__|fixtures?)(?:\/|$)/i.test(
      filePath,
    ) || /\.(?:snap|snapshot)(?:\.[^/]+)?$/i.test(filePath)
  );
}

function queryMatchBonus(text: string, query: string): number {
  const lowerText = text.toLowerCase();
  const phrases = extractAdjacentPhrases(query);
  const phraseHits = phrases.filter((phrase) => {
    const pattern = phrase
      .split(" ")
      .map(escapeRegexLiteral)
      .join("[^a-z0-9_$]+");
    return new RegExp(pattern, "i").test(text);
  }).length;
  const identifierHits = extractKeywords(query).filter(
    (term) =>
      /[a-z][A-Z]|[A-Z]{2}[a-z]/.test(term) &&
      lowerText.includes(term.toLowerCase()),
  ).length;
  const identifierAdjacency = phrases.some((phrase) =>
    lowerText.includes(phrase.replaceAll(" ", "").toLowerCase()),
  );
  return (
    Math.min(phraseHits, 2) * 120 +
    Math.min(identifierHits, 2) * 150 +
    (identifierAdjacency ? 500 : 0)
  );
}

async function keywordFallbackSearch(
  dirPath: string,
  query: string,
  limit: number,
  excludeGlobs?: string[],
): Promise<FormattedResult[]> {
  const rawTerms = extractKeywords(query);
  const searchTerms = (rawTerms.length > 0 ? rawTerms : query.split(/\s+/))
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 8);

  if (searchTerms.length === 0) {
    return [];
  }

  const rgPath = await getRipgrepBinPath();
  const regex = searchTerms.map(escapeRegexLiteral).join("|");
  const args = ["--json", "-n", "-i", "-C", "1", "-m", "3"];

  for (const glob of excludeGlobs ?? []) {
    args.push("--glob", `!${glob}`);
  }

  args.push(regex, dirPath);

  const output = await execRipgrepSearch(rgPath, args);
  const workspacePath = getWorkspaceRootForPath(dirPath) ?? dirPath;
  const parsed = parseRipgrepOutput(output, dirPath);

  const results = await Promise.all(
    parsed.results.map(async (fileResult) => {
      const lines = fileResult.searchResults.flatMap((result) => result.lines);
      const matchLines = lines.filter((line) => line.isMatch);
      if (matchLines.length === 0) {
        return null;
      }

      const normalizedFile = normalizeFallbackResultPath(
        fileResult.file,
        workspacePath,
        dirPath,
      );
      if (isExcludedSemanticResultPath(normalizedFile)) {
        return null;
      }

      const pathLower = normalizedFile.toLowerCase();
      const contentLower = lines
        .map((line) => line.text)
        .join("\n")
        .toLowerCase();
      const distinctPathTerms = searchTerms.filter((term) =>
        pathLower.includes(term.toLowerCase()),
      ).length;
      const distinctContentTerms = searchTerms.filter((term) =>
        contentLower.includes(term.toLowerCase()),
      ).length;
      const score =
        (distinctPathTerms * 100 +
          distinctContentTerms * 25 +
          queryMatchBonus(`${pathLower}\n${contentLower}`, query) +
          matchLines.length) *
        (isSnapshotOrFixturePath(normalizedFile) ? 0.65 : 1);

      const snippetLines = lines.slice(0, 8);
      const startLine = Math.min(...snippetLines.map((line) => line.line));
      const endLine = Math.max(...snippetLines.map((line) => line.line));
      let codeChunk = snippetLines
        .map((line) => `${line.line} | ${line.text.trimEnd()}`)
        .join("\n");
      const absoluteFile = path.resolve(workspacePath, fileResult.file);
      if (isStructuredConfigPath(absoluteFile)) {
        try {
          const redacted = redactStructuredSecrets(
            absoluteFile,
            await readFile(absoluteFile, "utf8"),
          );
          const visibleLines = redacted.content.split("\n");
          codeChunk = redacted.status
            ? "[CONTENT WITHHELD: invalid structured configuration]"
            : snippetLines
                .map(
                  (line) =>
                    `${line.line} | ${truncateLine(visibleLines[line.line - 1] ?? "").trimEnd()}`,
                )
                .join("\n");
        } catch {
          codeChunk =
            "[CONTENT WITHHELD: structured configuration could not be read safely]";
        }
      }

      return {
        file: normalizedFile,
        score,
        startLine,
        endLine,
        codeChunk,
      } satisfies FormattedResult;
    }),
  );
  return results
    .filter((result): result is FormattedResult => result != null)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit);
}

// --- Main entry point ---

export async function semanticSearch(
  dirPath: string,
  query: string,
  limit?: number,
  excludeGlobs?: string[],
  options: SemanticQueryOptions & {
    includeAllWorkspaceRoots?: boolean;
    exactFile?: boolean;
  } = {},
): Promise<ToolResult> {
  if (!isSemanticSearchEnabled(dirPath)) {
    const payload = semanticErrorPayload("disabled");
    return errorResult(String(payload.error), payload);
  }

  const workspacePaths = getWorkspaceRootsForSemanticQuery(dirPath, options);
  if (workspacePaths.length === 0) {
    const payload = semanticErrorPayload("no_workspace");
    return errorResult(String(payload.error), payload);
  }

  try {
    const embeddingsEnabled = isSemanticEmbeddingsEnabled(dirPath);
    let auth: OpenAiCodexResolvedAuth | null = null;
    if (embeddingsEnabled) {
      try {
        auth = await getEmbeddingAuth();
      } catch {
        auth = null;
      }
    }
    let embeddingReason: RankingReason | undefined = embeddingsEnabled
      ? auth
        ? undefined
        : "embedding_auth_missing"
      : "embeddings_disabled";
    let queryVector: number[] | undefined;
    if (auth) {
      try {
        queryVector = await generateEmbedding(expandQuery(query), auth);
      } catch (error) {
        embeddingReason = embeddingFailureReason(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const effectiveLimit = limit ?? 10;
    const allWorkspaceRoots = getWorkspaceRoots();

    const perWorkspaceResults = await Promise.all(
      workspacePaths.map(async (target) => {
        const { workspacePath, directoryPrefix } = target;
        const retrieval = await queryRetrievalStore({
          retrievalStoreRoot: resolveRetrievalStoreRoot(options, workspacePath),
          workspacePath,
          queryText: query,
          queryVector,
          directoryPrefix,
          exactFile: options.exactFile,
          limit: effectiveLimit,
          excludeGlobs,
        });
        const validated = await validateSemanticResults(
          retrieval.records,
          target,
          {
            hydrateChunks: true,
          },
        );
        return {
          results: prefixResultPaths(
            validated.results,
            workspacePath,
            allWorkspaceRoots,
          ),
          freshness: prefixFreshnessPaths(
            validated.freshness,
            workspacePath,
            allWorkspaceRoots,
          ),
          mode: retrieval.mode,
          ...(retrieval.degradedReason
            ? { degradedReason: retrieval.degradedReason }
            : {}),
        };
      }),
    );
    const results = perWorkspaceResults
      .flatMap((result) => result.results)
      .sort((a, b) => b.score - a.score)
      .slice(0, effectiveLimit);
    const degradedReason = perWorkspaceResults.find(
      (result) => result.degradedReason,
    )?.degradedReason;
    const ranking: BuildOutputOptions["ranking"] = perWorkspaceResults.every(
      (result) => result.mode === "hybrid",
    )
      ? "hybrid"
      : "lexical";
    const rankingReason =
      ranking === "hybrid"
        ? undefined
        : degradedReason
          ? classifyRankingReason(degradedReason)
          : (embeddingReason ?? "unknown");
    return buildOutput(query, formatResults(results), {
      ranking,
      ...(rankingReason ? { rankingReason } : {}),
      ...(rankingReason ? { guidance: rankingGuidance(rankingReason) } : {}),
      freshness: mergeFreshnessSummaries(
        perWorkspaceResults.map((result) => result.freshness),
      ),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const effectiveLimit = limit ?? 10;

    if (shouldFallbackToKeywordSearch(msg)) {
      try {
        const fallbackResults = await keywordFallbackSearch(
          dirPath,
          query,
          effectiveLimit,
          excludeGlobs,
        );
        const healthReason = msg.match(
          /Retrieval store is unavailable:\s*(vector_index_unavailable|missing_index|store_unavailable|repair_required|rebuild_required|lexical_index_unavailable|scalar_index_unavailable)/i,
        )?.[1];
        const classifiedReason = classifySemanticReasonFromError(msg);
        const fallbackReason = healthReason
          ? classifyRankingReason(healthReason)
          : classifiedReason
            ? classifyRankingReason(classifiedReason)
            : embeddingFailureReason(msg);
        return buildOutput(query, fallbackResults, {
          ranking: "keyword_fallback",
          rankingReason: fallbackReason,
          guidance: rankingGuidance(fallbackReason),
          warning: `Semantic search is temporarily unavailable (${summarizeSemanticFailure(msg)}); showing keyword-based fallback results instead.`,
        });
      } catch (fallbackError) {
        const fallbackMessage =
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
        return errorResult(msg, { fallback_error: fallbackMessage });
      }
    }

    const reason = classifySemanticReasonFromError(msg);
    if (reason) {
      const payload = semanticErrorPayload(reason, { detail: msg });
      return errorResult(String(payload.error), payload);
    }

    return errorResult(msg);
  }
}
