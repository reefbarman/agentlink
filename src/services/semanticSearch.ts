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
import {
  getWorkspaceRootForPath,
  getWorkspaceRoots,
  tryGetFirstWorkspaceRoot,
} from "../util/paths.js";
import {
  execRipgrepSearch,
  getRipgrepBinPath,
  parseRipgrepOutput,
} from "../util/ripgrep.js";
import { requestEmbeddings } from "../indexer/embeddingClient.js";
import { resolveContainedCodeIndexPath } from "../indexer/codeIndexPaths.js";
import {
  getCodeSourceId,
  getCodeWorkspaceScopeId,
} from "../indexer/codeRetrievalIdentity.js";
import type { RetrievalHealthReason } from "../core/retrieval/contracts.js";
import { LanceDbRetrievalRepository } from "../storage/retrieval/LanceDbRetrievalRepository.js";
import { canonicalizePath } from "../util/canonicalPath.js";

import { type ToolResult } from "../shared/types.js";
import { getSemanticReadinessMessage } from "../shared/semanticReadiness.js";
import { expandQuery, extractKeywords } from "./semanticQueryEnhancement.js";

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

export type SemanticFileQueryResult =
  | { status: "current"; startLine: number; endLine: number }
  | { status: "stale" | "deleted" | "unverified" };

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
        vectorScore * 0.6 + keywordScore * 0.25 + pathScore * 0.15;

      return { ...r, score: finalScore };
    })
    .sort((a, b) => b.score - a.score);
}

// --- Retrieval store query adapter ---

async function queryRetrievalStore(args: {
  retrievalStoreRoot: string | undefined;
  workspacePath: string;
  queryText: string;
  queryVector?: number[];
  directoryPrefix?: string;
  exactFile?: boolean;
  limit: number;
  excludeGlobs?: string[];
}): Promise<SemanticSearchRecord[]> {
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
    return rerankResults(
      records,
      extractKeywords(args.queryText),
      args.excludeGlobs,
    );
  } finally {
    await repository.close();
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

interface FormattedResult {
  file: string;
  score: number;
  startLine: number;
  endLine: number;
  codeChunk: string;
}

interface BuildOutputOptions {
  semantic?: boolean;
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
  options: BuildOutputOptions = {},
): ToolResult {
  const sections = results.map((r) => {
    return `## ${r.file} (score: ${r.score.toFixed(4)}, lines ${r.startLine}-${r.endLine})\n${r.codeChunk}`;
  });

  const output: Record<string, unknown> = {
    query,
    semantic: options.semantic ?? true,
    total_results: results.length,
    results: sections.join("\n\n"),
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
      ? { status: "current", content }
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
  const workspacePath = tryGetFirstWorkspaceRoot() ?? dirPath;
  const parsed = parseRipgrepOutput(output, dirPath);

  return parsed.results
    .map((fileResult) => {
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
        distinctPathTerms * 100 + distinctContentTerms * 25 + matchLines.length;
      const snippetLines = lines.slice(0, 8);
      const startLine = Math.min(...snippetLines.map((line) => line.line));
      const endLine = Math.max(...snippetLines.map((line) => line.line));
      const codeChunk = snippetLines
        .map((line) => `${line.line} | ${line.text.trimEnd()}`)
        .join("\n");

      return {
        file: normalizedFile,
        score,
        startLine,
        endLine,
        codeChunk,
      } satisfies FormattedResult;
    })
    .filter((result): result is FormattedResult => result != null)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit);
}

// --- Semantic helpers for other tools ---

/**
 * Query the index for chunks in a specific file matching a query.
 * Returns the best matching line range, or null if unavailable/no results.
 * Used by read_file to jump to the most relevant section.
 */
export async function semanticFileQuery(
  relFilePath: string,
  query: string,
  workspacePath?: string,
  expectedSourceRevision?: string,
  options: SemanticQueryOptions = {},
): Promise<SemanticFileQueryResult | null> {
  if (!isSemanticSearchEnabled(workspacePath)) return null;

  const resolvedWorkspacePath = workspacePath ?? tryGetFirstWorkspaceRoot();
  if (!resolvedWorkspacePath) return null;

  const normalizedPath = normalizeSemanticResultPath(relFilePath);

  try {
    const auth = await getEmbeddingAuth();
    const queryVector = auth
      ? await generateEmbedding(expandQuery(query), auth).catch(() => undefined)
      : undefined;
    const candidates = await queryRetrievalStore({
      retrievalStoreRoot: options.retrievalStoreRoot,
      workspacePath: resolvedWorkspacePath,
      queryText: query,
      queryVector,
      directoryPrefix: normalizedPath,
      exactFile: true,
      limit: 3,
    });
    if (candidates.length === 0) return null;
    if (expectedSourceRevision) {
      const matching = candidates.find(
        (candidate) =>
          candidate.payload?.sourceRevision === expectedSourceRevision,
      )?.payload;
      if (matching) {
        return {
          status: "current",
          startLine: matching.startLine,
          endLine: matching.endLine,
        };
      }
      return candidates.some((candidate) => candidate.payload?.sourceRevision)
        ? { status: "stale" }
        : { status: "unverified" };
    }
    const validated = await validateSemanticResults(
      candidates,
      {
        workspacePath: resolvedWorkspacePath,
        directoryPrefix: normalizedPath,
        scope: {
          absolutePath: path.resolve(resolvedWorkspacePath, normalizedPath),
          kind: "file",
        },
      },
      { hydrateChunks: false },
    );
    const best = validated.results[0]?.payload;
    if (best) {
      return {
        status: "current",
        startLine: best.startLine,
        endLine: best.endLine,
      };
    }
    if (validated.freshness.stale_sources.length > 0) {
      return { status: "stale" };
    }
    if (validated.freshness.deleted_sources.length > 0) {
      return { status: "deleted" };
    }
    if (validated.freshness.unverified_sources.length > 0) {
      return { status: "unverified" };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Query the index and return files ranked by semantic relevance.
 * Deduplicates by filePath, using the best score per file.
 * Used by list_files to find relevant files without knowing exact names.
 */
export async function semanticFileList(
  dirPath: string,
  query: string,
  limit: number = 20,
  options: SemanticQueryOptions & { includeAllWorkspaceRoots?: boolean } = {},
): Promise<{
  files: Array<{ path: string; score: number }>;
  error?: string;
  freshness?: SemanticFreshnessSummary;
} | null> {
  if (!isSemanticSearchEnabled(dirPath)) {
    return {
      files: [],
      ...semanticErrorPayload("disabled"),
    };
  }

  const workspacePaths = getWorkspaceRootsForSemanticQuery(dirPath, options);
  if (workspacePaths.length === 0) {
    return { files: [], ...semanticErrorPayload("no_workspace") };
  }

  try {
    const auth = await getEmbeddingAuth();
    const queryVector = auth
      ? await generateEmbedding(expandQuery(query), auth).catch(() => undefined)
      : undefined;

    // Fetch more chunks than limit since multiple chunks map to the same file
    const fetchLimit = limit * 5;
    const allWorkspaceRoots = getWorkspaceRoots();

    const perWorkspaceResults = await Promise.all(
      workspacePaths.map(async (target) => {
        const { workspacePath, directoryPrefix } = target;
        const results = await queryRetrievalStore({
          retrievalStoreRoot: options.retrievalStoreRoot,
          workspacePath,
          queryText: query,
          queryVector,
          directoryPrefix,
          limit: fetchLimit,
        });
        const validated = await validateSemanticResults(results, target, {
          hydrateChunks: false,
        });
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
        };
      }),
    );
    const results = perWorkspaceResults
      .flatMap((result) => result.results)
      .sort((a, b) => b.score - a.score)
      .slice(0, fetchLimit);

    // Deduplicate by filePath, keeping the best score per file
    const fileScores = new Map<string, number>();
    for (const r of results) {
      const fp = r.payload?.filePath;
      if (!fp) continue;
      const existing = fileScores.get(fp);
      if (existing == null || r.score > existing) {
        fileScores.set(fp, r.score);
      }
    }

    // Sort by score descending, take top `limit`
    const ranked = [...fileScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([fp, score]) => ({ path: fp, score }));

    const freshness = mergeFreshnessSummaries(
      perWorkspaceResults.map((result) => result.freshness),
    );
    return {
      files: ranked,
      ...(hasFreshnessIssues(freshness) ? { freshness } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = classifySemanticReasonFromError(msg);
    if (reason) {
      return { files: [], ...semanticErrorPayload(reason, { detail: msg }) };
    }
    return { files: [], error: msg };
  }
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
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(semanticErrorPayload("disabled")),
        },
      ],
    };
  }

  const workspacePaths = getWorkspaceRootsForSemanticQuery(dirPath, options);
  if (workspacePaths.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(semanticErrorPayload("no_workspace")),
        },
      ],
    };
  }

  try {
    const auth = await getEmbeddingAuth();
    const queryVector = auth
      ? await generateEmbedding(expandQuery(query), auth).catch(() => undefined)
      : undefined;
    const effectiveLimit = limit ?? 10;
    const allWorkspaceRoots = getWorkspaceRoots();

    const perWorkspaceResults = await Promise.all(
      workspacePaths.map(async (target) => {
        const { workspacePath, directoryPrefix } = target;
        const results = await queryRetrievalStore({
          retrievalStoreRoot: options.retrievalStoreRoot,
          workspacePath,
          queryText: query,
          queryVector,
          directoryPrefix,
          exactFile: options.exactFile,
          limit: effectiveLimit,
          excludeGlobs,
        });
        const validated = await validateSemanticResults(results, target, {
          hydrateChunks: true,
        });
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
        };
      }),
    );
    const results = perWorkspaceResults
      .flatMap((result) => result.results)
      .sort((a, b) => b.score - a.score)
      .slice(0, effectiveLimit);
    return buildOutput(query, formatResults(results), {
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
        return buildOutput(query, fallbackResults, {
          semantic: false,
          warning: `Semantic search is temporarily unavailable (${summarizeSemanticFailure(msg)}); showing keyword-based fallback results instead.`,
        });
      } catch (fallbackError) {
        const fallbackMessage =
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: msg,
                fallback_error: fallbackMessage,
              }),
            },
          ],
        };
      }
    }

    const reason = classifySemanticReasonFromError(msg);
    if (reason) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(semanticErrorPayload(reason, { detail: msg })),
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
    };
  }
}
