import type { OpenAiCompatibleSseFrame } from "./types.js";

export class OpenAiCompatibleSseError extends Error {
  constructor(
    message: string,
    readonly truncated: boolean,
  ) {
    super(message);
    this.name = "OpenAiCompatibleSseError";
  }
}

/**
 * Incrementally parses an SSE byte stream. The parser intentionally operates on
 * frames rather than lines so JSON payloads may cross arbitrary transport
 * chunks, and supports both LF and CRLF delimiters.
 */
export async function* parseOpenAiCompatibleSse(
  source: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<OpenAiCompatibleSseFrame> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of source) {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
    while (true) {
      const boundary = findFrameBoundary(buffer);
      if (!boundary) break;
      const rawFrame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const frame = parseFrame(rawFrame);
      if (frame) yield frame;
    }
  }

  buffer += decoder.decode();
  while (true) {
    const boundary = findFrameBoundary(buffer);
    if (!boundary) break;
    const frame = parseFrame(buffer.slice(0, boundary.index));
    buffer = buffer.slice(boundary.index + boundary.length);
    if (frame) yield frame;
  }

  if (buffer.trim()) {
    const frame = parseFrame(buffer);
    if (frame) yield frame;
  }
}

function findFrameBoundary(
  value: string,
): { index: number; length: number } | undefined {
  const match = /\r\n\r\n|\r\n\r|\r\n\n|\r\r\n|\r\r|\n\r\n|\n\r|\n\n/.exec(
    value,
  );
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function parseFrame(raw: string): OpenAiCompatibleSseFrame | undefined {
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;

  for (const line of raw.split(/\r?\n|\r/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
  }

  if (data.length === 0) return undefined;
  return {
    data: data.join("\n"),
    ...(event !== undefined ? { event } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(retry !== undefined ? { retry } : {}),
  };
}
