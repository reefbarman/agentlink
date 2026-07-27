import type { Chunk } from "./types.js";

export const MAX_CODE_INDEX_CHUNK_CHARS = 1_000;
export const MAX_CODE_INDEX_EMBEDDING_CHARS = 20_000;

export interface FinalizeCodeChunksOptions {
  language?: string;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  css: "css",
  scss: "scss",
  sh: "shellscript",
  bash: "shellscript",
  ps1: "powershell",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
};

export function inferCodeLanguage(filePath: string): string | undefined {
  const extension = /\.([^.\\/]+)$/.exec(filePath)?.[1]?.toLowerCase();
  return extension ? LANGUAGE_BY_EXTENSION[extension] : undefined;
}

export function finalizeCodeChunks(
  chunks: Chunk[],
  options: FinalizeCodeChunksOptions = {},
): Chunk[] {
  return chunks.flatMap((chunk) =>
    splitChunk(chunk).map((part) => {
      const language =
        part.language ?? options.language ?? inferCodeLanguage(part.filePath);
      return {
        ...part,
        ...(language ? { language } : {}),
        embeddingContent: buildEmbeddingContent(part),
      };
    }),
  );
}

function splitChunk(chunk: Chunk): Chunk[] {
  const lines = chunk.content.split("\n");
  if (lines.every((line) => line.length <= MAX_CODE_INDEX_CHUNK_CHARS)) {
    return [chunk];
  }

  const parts: Chunk[] = [];
  let normalStart = 0;
  const flushNormal = (end: number) => {
    if (end <= normalStart) return;
    const content = lines.slice(normalStart, end).join("\n");
    if (!content.trim()) return;
    parts.push({
      ...chunk,
      content,
      startLine: chunk.startLine + normalStart,
      endLine: chunk.startLine + end - 1,
    });
  };

  for (let lineOffset = 0; lineOffset < lines.length; lineOffset++) {
    const line = lines[lineOffset];
    if (line.length <= MAX_CODE_INDEX_CHUNK_CHARS) continue;
    flushNormal(lineOffset);
    const sourceLine = chunk.startLine + lineOffset;
    for (
      let offset = 0;
      offset < line.length;
      offset += MAX_CODE_INDEX_CHUNK_CHARS
    ) {
      parts.push({
        ...chunk,
        content: line.slice(offset, offset + MAX_CODE_INDEX_CHUNK_CHARS),
        startLine: sourceLine,
        endLine: sourceLine,
      });
    }
    normalStart = lineOffset + 1;
  }
  flushNormal(lines.length);
  return parts;
}

function buildEmbeddingContent(chunk: Chunk): string {
  const scope = chunk.scope ?? [];
  const contentLines = chunk.content.split("\n");
  const immediateScope = scope.at(-1);
  const body =
    immediateScope && contentLines[0]?.trim() === immediateScope
      ? contentLines.slice(1).join("\n").trimStart()
      : chunk.content;
  const header = [
    `// ${chunk.relPath.replace(/\\/g, "/")}`,
    ...(scope.length > 0 ? [`// ${scope.join(" > ")}`] : []),
  ].join("\n");
  return `${header}\n${body}`.slice(0, MAX_CODE_INDEX_EMBEDDING_CHARS);
}
