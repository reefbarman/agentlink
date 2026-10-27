/**
 * VS Code's `read_file` content-view windowing: anchor resolution, offset and
 * limit handling, and numbered lines. Hosts own file access, media, and the
 * metadata they add around the window.
 */

/** Default line count for the content view. */
export const READ_FILE_CONTENT_DEFAULT_LIMIT = 2000;
/** Largest image returned as an image block. */
export const READ_FILE_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Largest PDF whose text is extracted. */
export const READ_FILE_MAX_PDF_BYTES = 50 * 1024 * 1024;

/** Only types accepted by the Anthropic Messages API (image content blocks). */
export const READ_FILE_IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function readFileImageTooLargeError(size: number): string {
  return `Image too large (${(size / 1024 / 1024).toFixed(1)} MB). Max: ${READ_FILE_MAX_IMAGE_BYTES / 1024 / 1024} MB`;
}

export function readFilePdfTooLargeError(size: number): string {
  return `PDF too large (${(size / 1024 / 1024).toFixed(1)} MB). Max: ${READ_FILE_MAX_PDF_BYTES / 1024 / 1024} MB`;
}

export interface ReadFileContentWindowParams {
  readonly offset?: number;
  readonly limit?: number;
  readonly anchor?: string;
  readonly anchor_regex?: string;
  readonly anchor_offset?: number;
  /**
   * Optional host output budget for the numbered content. VS Code passes
   * none. When set, the window ends at the last whole line that fits (at
   * least one line, cut to the budget if it alone exceeds it).
   */
  readonly maxContentChars?: number;
}

export type ReadFileContentWindow =
  | { readonly status: "error"; readonly error: string }
  | { readonly status: "empty"; readonly totalLines: number }
  | {
      readonly status: "window";
      readonly totalLines: number;
      readonly offset: number;
      readonly lineCount: number;
      /** `"start-end"`, as VS Code reports it. */
      readonly showing: string;
      readonly truncated: boolean;
      readonly numbered: string;
      readonly anchorMatch?: Readonly<Record<string, unknown>>;
      /** Present only when `maxContentChars` shortened the window. */
      readonly budget?: {
        readonly maxContentChars: number;
        readonly nextOffset?: number;
        readonly lineCut: boolean;
      };
    };

/** Plan a content-view window exactly as VS Code's `read_file` does. */
export function planReadFileContentWindow(
  text: string,
  params: ReadFileContentWindowParams,
): ReadFileContentWindow {
  const allLines = text.split("\n");
  const totalLines = allLines.length;

  if (params.anchor && params.anchor_regex) {
    return {
      status: "error",
      error: "Specify only one of 'anchor' or 'anchor_regex' (not both).",
    };
  }

  let anchorHit:
    | { mode: "literal" | "regex"; pattern: string; line: number }
    | undefined;
  if (params.anchor_regex && params.offset == null) {
    let anchorRegex: RegExp;
    try {
      anchorRegex = new RegExp(params.anchor_regex, "m");
    } catch (err) {
      return {
        status: "error",
        error: `Invalid anchor_regex: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const match = text.match(anchorRegex);
    if (match && match.index != null) {
      anchorHit = {
        mode: "regex",
        pattern: params.anchor_regex,
        line: text.slice(0, match.index).split("\n").length,
      };
    }
  } else if (params.anchor && params.offset == null) {
    const index = text.indexOf(params.anchor);
    if (index >= 0) {
      anchorHit = {
        mode: "literal",
        pattern: params.anchor,
        line: text.slice(0, index).split("\n").length,
      };
    }
  }

  const baseOffset = anchorHit
    ? anchorHit.line
    : Math.max(1, params.offset ?? 1);
  const shouldApplyAnchorOffset = params.offset == null && !!anchorHit;
  const anchorOffset =
    shouldApplyAnchorOffset && Number.isFinite(params.anchor_offset)
      ? Math.trunc(params.anchor_offset as number)
      : 0;
  const offset = Math.max(1, baseOffset + anchorOffset);

  if (offset > totalLines) return { status: "empty", totalLines };

  const rawLimit = params.limit ?? READ_FILE_CONTENT_DEFAULT_LIMIT;
  if (rawLimit <= 0) {
    return {
      status: "error",
      error: `Invalid limit: ${rawLimit}. Must be a positive number.`,
    };
  }
  const limit = Math.min(rawLimit, totalLines - offset + 1);
  let lines = allLines.slice(offset - 1, offset - 1 + limit);
  let numbered = numberLines(lines, offset);

  let budget:
    | { maxContentChars: number; nextOffset?: number; lineCut: boolean }
    | undefined;
  const maxChars = params.maxContentChars;
  if (maxChars !== undefined && maxChars > 0 && numbered.length > maxChars) {
    let used = 0;
    let kept = 0;
    for (const line of lines) {
      const cost = `${offset + kept} | ${line}`.length + (kept > 0 ? 1 : 0);
      if (kept > 0 && used + cost > maxChars) break;
      used += cost;
      kept += 1;
      if (used > maxChars) break;
    }
    lines = lines.slice(0, kept);
    numbered = numberLines(lines, offset);
    const lineCut = numbered.length > maxChars;
    if (lineCut) numbered = numbered.slice(0, maxChars);
    const next = offset + lines.length;
    budget = {
      maxContentChars: maxChars,
      ...(next <= totalLines ? { nextOffset: next } : {}),
      lineCut,
    };
  }

  let anchorMatch: Record<string, unknown> | undefined;
  if (anchorHit) {
    anchorMatch = {
      mode: anchorHit.mode,
      pattern: anchorHit.pattern,
      line: anchorHit.line,
      anchor_offset: Number.isFinite(params.anchor_offset)
        ? Math.trunc(params.anchor_offset as number)
        : 0,
    };
  } else if ((params.anchor || params.anchor_regex) && params.offset == null) {
    anchorMatch = {
      status: "not_found",
      ...(params.anchor && { mode: "literal", pattern: params.anchor }),
      ...(params.anchor_regex && {
        mode: "regex",
        pattern: params.anchor_regex,
      }),
    };
  }

  return {
    status: "window",
    totalLines,
    offset,
    lineCount: lines.length,
    showing: `${offset}-${offset + lines.length - 1}`,
    truncated:
      !(offset === 1 && lines.length === totalLines) ||
      budget?.lineCut === true,
    numbered,
    ...(anchorMatch ? { anchorMatch } : {}),
    ...(budget ? { budget } : {}),
  };
}

function numberLines(lines: readonly string[], offset: number): string {
  return lines.map((line, index) => `${offset + index} | ${line}`).join("\n");
}
