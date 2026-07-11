import type * as http from "http";

export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

export function readBoundedBody(
  req: http.IncomingMessage,
  maxBytes = MAX_REQUEST_BODY_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
    };
    const rejectInvalid = (): void => {
      cleanup();
      const swallowDrainError = (): void => undefined;
      const cleanupDrain = (): void => {
        req.off("error", swallowDrainError);
        req.off("end", cleanupDrain);
        req.off("close", cleanupDrain);
      };
      req.on("error", swallowDrainError);
      req.once("end", cleanupDrain);
      req.once("close", cleanupDrain);
      req.resume();
      reject(new Error("invalid_request_body"));
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        rejectInvalid();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onAborted = (): void => rejectInvalid();
    const onError = (): void => rejectInvalid();

    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      rejectInvalid();
      return;
    }

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
  });
}

export async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = MAX_REQUEST_BODY_BYTES,
): Promise<unknown> {
  let raw: string;
  try {
    raw = (await readBoundedBody(req, maxBytes)).toString("utf-8").trim();
  } catch {
    throw new Error("invalid_json");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid_json");
  }
}
