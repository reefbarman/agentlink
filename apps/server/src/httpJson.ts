import type { IncomingMessage, ServerResponse } from "node:http";

import { singleHeader } from "./requestGuard.js";

const DEFAULT_MAX_JSON_BODY_BYTES = 16 * 1024;

/**
 * Error with a public status and code. Thrown from server routes and
 * application hooks; the server maps it to a JSON error response.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "HttpError";
  }
}

/**
 * Read a bounded `application/json` object body. When `signal` aborts (for
 * example on session revocation) a stalled read stops and the request is
 * destroyed rather than waiting for the client to finish sending.
 */
export async function readJsonBody(
  request: IncomingMessage,
  maxBytes = DEFAULT_MAX_JSON_BODY_BYTES,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const contentType = singleHeader(request.headers["content-type"]) ?? "";
  if (!/^application\/json(\s*;|$)/iu.test(contentType)) {
    throw new HttpError(415, "json_required");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  if (signal?.aborted) throw new HttpError(401, "authentication_required");
  const stopReading = () =>
    request.destroy(new HttpError(401, "authentication_required"));
  signal?.addEventListener("abort", stopReading, { once: true });
  try {
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw new HttpError(413, "body_too_large");
      chunks.push(chunk as Buffer);
    }
  } finally {
    signal?.removeEventListener("abort", stopReading);
  }
  if (signal?.aborted) throw new HttpError(401, "authentication_required");
  try {
    const parsed = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the shared error.
  }
  throw new HttpError(400, "invalid_json");
}

export function stringField(
  body: Record<string, unknown>,
  name: string,
): string {
  const value = body[name];
  if (typeof value !== "string") throw new HttpError(400, `${name}_required`);
  return value;
}

export function optionalStringField(
  body: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${name}_invalid`);
  return value;
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function sendEmpty(response: ServerResponse, status: number): void {
  response.writeHead(status);
  response.end();
}
