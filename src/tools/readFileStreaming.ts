import { createReadStream } from "fs";

import {
  READ_FILE_CONTENT_DEFAULT_LIMIT,
  type ReadFileContentWindow,
  type ReadFileContentWindowParams,
} from "@agentlink/core/read-file-content";

/**
 * Text files above this size are read as a bounded line window instead of
 * whole. It stays below VS Code's 50 MB extension synchronization limit, so
 * anything VS Code cannot open is always streamed.
 */
export const READ_FILE_STREAM_THRESHOLD_BYTES = 32 * 1024 * 1024;

/** Longest line kept from a streamed file; longer lines are cut. */
export const READ_FILE_STREAMED_LINE_MAX_CHARS = 20_000;

type LineVisit = "continue" | "stop" | "count";

/**
 * Visit lines split exactly like `text.split("\n")`, without holding the
 * file. After a visitor returns "count", remaining newlines are only counted.
 * Lines longer than the cap are cut and reported as such.
 */
async function scanLines(
  filePath: string,
  visit: (line: string, lineNumber: number, cut: boolean) => LineVisit,
): Promise<{ totalLines: number; complete: boolean }> {
  const stream = createReadStream(filePath, {
    encoding: "utf8",
    highWaterMark: 1024 * 1024,
  });
  let pending = "";
  let pendingCut = false;
  let lineNumber = 1;
  let counting = false;
  const append = (text: string) => {
    if (pending.length >= READ_FILE_STREAMED_LINE_MAX_CHARS) {
      if (text) pendingCut = true;
      return;
    }
    const room = READ_FILE_STREAMED_LINE_MAX_CHARS - pending.length;
    if (text.length > room) {
      pending += text.slice(0, room);
      pendingCut = true;
    } else {
      pending += text;
    }
  };
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      if (counting) {
        lineNumber += countNewlines(chunk, 0);
        continue;
      }
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf("\n", start);
        if (newline < 0) {
          append(chunk.slice(start));
          break;
        }
        append(chunk.slice(start, newline));
        const line = pending;
        const cut = pendingCut;
        pending = "";
        pendingCut = false;
        start = newline + 1;
        const next = visit(line, lineNumber, cut);
        lineNumber += 1;
        if (next === "stop")
          return { totalLines: lineNumber - 1, complete: false };
        if (next === "count") {
          counting = true;
          lineNumber += countNewlines(chunk, start);
          break;
        }
      }
    }
    if (!counting) visit(pending, lineNumber, pendingCut);
    return { totalLines: lineNumber, complete: true };
  } finally {
    stream.destroy();
  }
}

function countNewlines(text: string, from: number): number {
  let count = 0;
  for (
    let index = text.indexOf("\n", from);
    index >= 0;
    index = text.indexOf("\n", index + 1)
  ) {
    count += 1;
  }
  return count;
}

export type StreamedReadFileContentWindow = ReadFileContentWindow & {
  /** Lines in the window cut at READ_FILE_STREAMED_LINE_MAX_CHARS. */
  readonly longLinesCut?: number;
};

/**
 * The content-view window `planReadFileContentWindow` would return, read
 * without loading the file. Anchors match within one line, so a regex anchor
 * spanning lines is not found here.
 */
export async function streamReadFileContentWindow(
  filePath: string,
  params: ReadFileContentWindowParams,
): Promise<StreamedReadFileContentWindow> {
  if (params.anchor && params.anchor_regex) {
    return {
      status: "error",
      error: "Specify only one of 'anchor' or 'anchor_regex' (not both).",
    };
  }
  const useAnchor =
    params.offset == null && Boolean(params.anchor || params.anchor_regex);
  let anchorTest: ((line: string) => boolean) | undefined;
  if (useAnchor && params.anchor_regex) {
    let regex: RegExp;
    try {
      regex = new RegExp(params.anchor_regex, "m");
    } catch (err) {
      return {
        status: "error",
        error: `Invalid anchor_regex: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    anchorTest = (line) => regex.test(line);
  } else if (useAnchor && params.anchor) {
    const anchor = params.anchor;
    anchorTest = (line) => line.includes(anchor);
  }

  let anchorLine: number | undefined;
  if (anchorTest) {
    const test = anchorTest;
    await scanLines(filePath, (line, lineNumber) => {
      if (!test(line)) return "continue";
      anchorLine = lineNumber;
      return "stop";
    });
  }

  const anchorOffset =
    anchorLine !== undefined && Number.isFinite(params.anchor_offset)
      ? Math.trunc(params.anchor_offset as number)
      : 0;
  const offset = Math.max(
    1,
    (anchorLine ?? Math.max(1, params.offset ?? 1)) + anchorOffset,
  );
  const rawLimit = params.limit ?? READ_FILE_CONTENT_DEFAULT_LIMIT;

  const lines: string[] = [];
  let longLinesCut = 0;
  const { totalLines } = await scanLines(filePath, (line, lineNumber, cut) => {
    if (lineNumber < offset) return "continue";
    if (rawLimit <= 0) return "count";
    lines.push(line);
    if (cut) longLinesCut += 1;
    return lines.length >= rawLimit ? "count" : "continue";
  });

  if (offset > totalLines) return { status: "empty", totalLines };
  if (rawLimit <= 0) {
    return {
      status: "error",
      error: `Invalid limit: ${rawLimit}. Must be a positive number.`,
    };
  }

  let anchorMatch: Record<string, unknown> | undefined;
  if (anchorLine !== undefined) {
    anchorMatch = {
      mode: params.anchor_regex ? "regex" : "literal",
      pattern: params.anchor_regex ?? params.anchor,
      line: anchorLine,
      anchor_offset: anchorOffset,
    };
  } else if (useAnchor) {
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
      !(offset === 1 && lines.length === totalLines) || longLinesCut > 0,
    numbered: lines
      .map((line, index) => `${offset + index} | ${line}`)
      .join("\n"),
    ...(anchorMatch ? { anchorMatch } : {}),
    ...(longLinesCut > 0 ? { longLinesCut } : {}),
  };
}
