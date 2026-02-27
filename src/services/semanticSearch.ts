import * as vscode from "vscode";
import * as path from "path";
import { createHash } from "crypto";

import { getFirstWorkspaceRoot } from "../util/paths.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

// --- Configuration helpers ---

function getQdrantUrl(): string {
  return vscode.workspace
    .getConfiguration("agentlink")
    .get<string>("qdrantUrl", "http://localhost:6333");
}

function getOpenAiApiKey(): string {
  return (
    vscode.workspace
      .getConfiguration("agentlink")
      .get<string>("openaiApiKey", "") ||
    process.env.OPENAI_API_KEY ||
    ""
  );
}

function isSemanticSearchEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("agentlink")
    .get<boolean>("semanticSearchEnabled", false);
}

// --- Collection name derivation (must match Roo Code) ---

function getCollectionName(workspacePath: string): string {
  const hash = createHash("sha256").update(workspacePath).digest("hex");
  return `ws-${hash.substring(0, 16)}`;
}

// --- OpenAI Embeddings via fetch ---

async function generateEmbedding(
  text: string,
  apiKey: string,
): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${error}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return data.data[0].embedding;
}

// --- Qdrant REST API ---

interface QdrantPayload {
  filePath: string;
  codeChunk: string;
  startLine: number;
  endLine: number;
  type?: string;
}

interface QdrantSearchResult {
  id: string | number;
  score: number;
  payload?: QdrantPayload;
}

async function queryQdrant(
  qdrantUrl: string,
  collectionName: string,
  queryVector: number[],
  directoryPrefix?: string,
  limit: number = 10,
): Promise<QdrantSearchResult[]> {
  // Build filter — always exclude metadata points
  const mustNot = [{ key: "type", match: { value: "metadata" } }];
  const must: Array<{ key: string; match: { value: string } }> = [];

  if (directoryPrefix) {
    const normalized = path.posix.normalize(
      directoryPrefix.replace(/\\/g, "/"),
    );
    if (normalized !== "." && normalized !== "./") {
      const cleaned = normalized.startsWith("./")
        ? normalized.slice(2)
        : normalized;
      const segments = cleaned.split("/").filter(Boolean);
      segments.forEach((segment, index) => {
        must.push({ key: `pathSegments.${index}`, match: { value: segment } });
      });
    }
  }

  const filter: Record<string, unknown> = { must_not: mustNot };
  if (must.length > 0) {
    filter.must = must;
  }

  const body = {
    query: queryVector,
    filter,
    score_threshold: 0.4,
    limit,
    params: {
      hnsw_ef: 128,
      exact: false,
    },
    with_payload: {
      include: ["filePath", "codeChunk", "startLine", "endLine"],
    },
  };

  const url = `${qdrantUrl.replace(/\/+$/, "")}/collections/${collectionName}/points/query`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Qdrant is not reachable at ${qdrantUrl}. Ensure Qdrant is running and Roo Code codebase indexing is enabled. (${message})`,
    );
  }

  if (!response.ok) {
    const error = await response.text();
    if (response.status === 404) {
      throw new Error(
        `No codebase index found for this workspace (collection: ${collectionName}). Ensure Roo Code has indexed this workspace.`,
      );
    }
    throw new Error(`Qdrant API error (${response.status}): ${error}`);
  }

  const data = (await response.json()) as {
    result?: { points?: QdrantSearchResult[] };
  };
  return data.result?.points ?? [];
}

// --- Main entry point ---

export async function semanticSearch(
  dirPath: string,
  query: string,
  limit?: number,
): Promise<ToolResult> {
  if (!isSemanticSearchEnabled()) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error:
              "Semantic search is not enabled. Set agentlink.semanticSearchEnabled to true.",
          }),
        },
      ],
    };
  }

  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error:
              "OpenAI API key not configured. Set agentlink.openaiApiKey or OPENAI_API_KEY env var.",
          }),
        },
      ],
    };
  }

  const qdrantUrl = getQdrantUrl();
  const workspacePath = getFirstWorkspaceRoot();
  const collectionName = getCollectionName(workspacePath);

  // Compute directory prefix relative to workspace
  const relativeDir = path.relative(workspacePath, dirPath);
  const directoryPrefix = relativeDir === "" ? undefined : relativeDir;

  // Generate embedding for the query
  const queryVector = await generateEmbedding(query, apiKey);

  // Query Qdrant
  const effectiveLimit = limit ?? 10;
  const results = await queryQdrant(
    qdrantUrl,
    collectionName,
    queryVector,
    directoryPrefix,
    effectiveLimit,
  );

  // Format results
  const formattedResults = results
    .filter((r) => r.payload?.filePath)
    .map((r) => ({
      file: r.payload!.filePath,
      score: r.score,
      startLine: r.payload!.startLine,
      endLine: r.payload!.endLine,
      codeChunk: r.payload!.codeChunk?.trim() ?? "",
    }));

  // Build output in a format Claude Code can read well
  const sections = formattedResults.map(
    (r) =>
      `## ${r.file} (score: ${r.score.toFixed(4)}, lines ${r.startLine}-${r.endLine})\n${r.codeChunk}`,
  );

  const output = {
    query,
    semantic: true,
    total_results: formattedResults.length,
    results: sections.join("\n\n"),
  };

  return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
}
