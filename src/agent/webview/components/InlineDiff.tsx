import { useMemo } from "preact/hooks";

/**
 * A parsed search/replace block from an apply_diff call.
 */
interface DiffBlock {
  search: string;
  replace: string;
  index: number;
}

/**
 * Parse apply_diff search/replace blocks from the raw diff string.
 * Mirrors the server-side parseSearchReplaceBlocks logic.
 */
function parseDiffBlocks(diff: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  const lines = diff.split("\n");
  let i = 0;
  let blockIndex = 0;

  const SEARCH = "<<<<<<< SEARCH";
  const DIVIDER_NEW = "======= DIVIDER =======";
  const DIVIDER_LEGACY = "=======";
  const REPLACE = ">>>>>>> REPLACE";

  const useNewDelimiter = lines.some((l) => l.trimEnd() === DIVIDER_NEW);

  while (i < lines.length) {
    if (lines[i].trimEnd().startsWith(SEARCH)) {
      i++;
      const searchLines: string[] = [];
      const replaceLines: string[] = [];
      let inReplace = false;
      let found = false;

      while (i < lines.length) {
        const trimmed = lines[i].trimEnd();
        const isDivider = useNewDelimiter
          ? trimmed === DIVIDER_NEW
          : trimmed === DIVIDER_LEGACY || trimmed === DIVIDER_NEW;

        if (isDivider && !inReplace) {
          inReplace = true;
          i++;
          continue;
        }

        if (isDivider && inReplace) {
          // Malformed — break out
          break;
        }

        if (trimmed === REPLACE) {
          blocks.push({
            search: searchLines.join("\n"),
            replace: replaceLines.join("\n"),
            index: blockIndex,
          });
          found = true;
          blockIndex++;
          i++;
          break;
        }

        if (inReplace) {
          replaceLines.push(lines[i]);
        } else {
          searchLines.push(lines[i]);
        }
        i++;
      }

      if (!found) {
        blockIndex++;
      }
    } else {
      i++;
    }
  }
  return blocks;
}

/**
 * Compute a simple line-level diff between two strings.
 * Returns an array of lines tagged as context, removed, or added.
 */
type DiffLine =
  | { type: "context"; text: string }
  | { type: "removed"; text: string }
  | { type: "added"; text: string };

function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const result: DiffLine[] = [];

  // Use a simple LCS-based approach for small diffs.
  // For very large diffs, fall back to showing all removed then all added.
  const MAX_LCS = 500;
  if (oldLines.length * newLines.length > MAX_LCS * MAX_LCS) {
    for (const line of oldLines) result.push({ type: "removed", text: line });
    for (const line of newLines) result.push({ type: "added", text: line });
    return result;
  }

  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from<number>({ length: n + 1 }).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff
  const diff: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diff.push({ type: "context", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.push({ type: "added", text: newLines[j - 1] });
      j--;
    } else {
      diff.push({ type: "removed", text: oldLines[i - 1] });
      i--;
    }
  }
  diff.reverse();

  // Collapse long runs of context (show at most 3 lines of context around changes)
  const CONTEXT = 3;
  const hasChange = diff.map((d) => d.type !== "context");
  for (let k = 0; k < diff.length; k++) {
    if (diff[k].type !== "context") {
      result.push(diff[k]);
      continue;
    }
    // Check if this context line is within CONTEXT lines of a change
    let near = false;
    for (
      let look = Math.max(0, k - CONTEXT);
      look <= Math.min(diff.length - 1, k + CONTEXT);
      look++
    ) {
      if (hasChange[look]) {
        near = true;
        break;
      }
    }
    if (near) {
      result.push(diff[k]);
    } else if (
      result.length === 0 ||
      result[result.length - 1].type !== "context"
    ) {
      // Placeholder for collapsed context — we'll skip rendering these
      // Only add one "context" placeholder per collapsed run
    }
  }

  return result;
}

interface InlineDiffBlockProps {
  block: DiffBlock;
  showHeader: boolean;
}

/** Render a single search/replace block as an inline diff. */
function InlineDiffBlock({ block, showHeader }: InlineDiffBlockProps) {
  const lines = useMemo(
    () => computeLineDiff(block.search, block.replace),
    [block.search, block.replace],
  );

  return (
    <div class="inline-diff-block">
      {showHeader && (
        <div class="inline-diff-block-header">Hunk {block.index + 1}</div>
      )}
      <pre class="inline-diff-code">
        {lines.map((line, i) => (
          <div key={i} class={`inline-diff-line inline-diff-${line.type}`}>
            <span class="inline-diff-marker">
              {line.type === "removed"
                ? "−"
                : line.type === "added"
                  ? "+"
                  : " "}
            </span>
            <span class="inline-diff-text">{line.text || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

interface FindReplaceDiffProps {
  find: string;
  replace: string;
  isRegex?: boolean;
}

/** Render a find/replace as a mini diff. */
function FindReplaceDiff({ find, replace, isRegex }: FindReplaceDiffProps) {
  return (
    <div class="inline-diff-block">
      <pre class="inline-diff-code">
        <div class="inline-diff-line inline-diff-removed">
          <span class="inline-diff-marker">−</span>
          <span class="inline-diff-text">{isRegex ? `/${find}/` : find}</span>
        </div>
        <div class="inline-diff-line inline-diff-added">
          <span class="inline-diff-marker">+</span>
          <span class="inline-diff-text">{replace}</span>
        </div>
      </pre>
    </div>
  );
}

export interface InlineDiffProps {
  toolName: string;
  input: Record<string, unknown> | null;
}

/**
 * Renders an inline diff view for write tools (apply_diff, write_file, find_and_replace).
 * Returns null if the tool is not a write tool or has no parseable diff content.
 */
export function InlineDiff({ toolName, input }: InlineDiffProps) {
  if (!input) return null;

  if (toolName === "apply_diff") {
    const diff = input.diff as string | undefined;
    if (!diff) return null;

    const blocks = parseDiffBlocks(diff);
    if (blocks.length === 0) return null;

    return (
      <div class="inline-diff-container">
        {blocks.map((block) => (
          <InlineDiffBlock
            key={block.index}
            block={block}
            showHeader={blocks.length > 1}
          />
        ))}
      </div>
    );
  }

  if (toolName === "find_and_replace") {
    const find = input.find as string | undefined;
    const replace = input.replace as string | undefined;
    if (!find && !replace) return null;

    return (
      <div class="inline-diff-container">
        <FindReplaceDiff
          find={find ?? ""}
          replace={replace ?? ""}
          isRegex={input.regex === true}
        />
      </div>
    );
  }

  if (toolName === "write_file") {
    const content = input.content as string | undefined;
    if (!content) return null;

    // For write_file, show the content as a code preview (we don't have the original)
    const lines = content.split("\n");
    const maxPreviewLines = 50;
    const truncated = lines.length > maxPreviewLines;
    const displayLines = truncated ? lines.slice(0, maxPreviewLines) : lines;

    return (
      <div class="inline-diff-container">
        <div class="inline-diff-block">
          <pre class="inline-diff-code inline-diff-write-preview">
            {displayLines.map((line, i) => (
              <div key={i} class="inline-diff-line inline-diff-added">
                <span class="inline-diff-marker">+</span>
                <span class="inline-diff-text">{line || " "}</span>
              </div>
            ))}
            {truncated && (
              <div class="inline-diff-line inline-diff-context">
                <span class="inline-diff-marker"> </span>
                <span class="inline-diff-text inline-diff-truncated">
                  ... {lines.length - maxPreviewLines} more lines
                </span>
              </div>
            )}
          </pre>
        </div>
      </div>
    );
  }

  return null;
}
