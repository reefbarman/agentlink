/**
 * Externalizes oversized string payloads (typically multi-MB base64 images
 * from MCP screenshots or pasted media) out of the persisted transcript.
 *
 * Why: `messages.json` is re-serialized on the extension-host main thread at
 * every persist tick. Transcripts that embed screenshots grow to hundreds of
 * MB, and `JSON.stringify` at that size blocks the event loop for seconds —
 * the confirmed mechanism behind the recurring extension-host lockups. With
 * payloads externalized, the transcript file stays text-sized and each unique
 * payload is written to disk exactly once, content-addressed.
 *
 * On-disk shape: `<historyDir>/<sessionId>/attachments/<sha256>.payload`
 * holding the exact original string (base64 stays base64 — no decode step),
 * while the transcript stores a marker string in its place:
 * `agentlink-external-payload:v1:<sha256>:<length>`. Markers survive
 * round-trips: a marker whose payload file is missing rehydrates to itself
 * and re-externalizes to the same marker, never corrupting the transcript.
 *
 * The in-memory transcript is untouched — the agent runtime keeps real bytes
 * for API calls; only the persistence boundary transforms them.
 */

import * as crypto from "crypto";

import type { AgentMessage } from "./types.js";

export const TRANSCRIPT_PAYLOAD_MARKER_PREFIX =
  "agentlink-external-payload:v1:";

/**
 * Strings at or above this length are externalized. Chosen to catch base64
 * media (a screenshot is 1.5–2.2 M chars) while leaving ordinary tool output
 * and message text inline so `messages.json` remains self-contained for the
 * common case.
 */
export const TRANSCRIPT_PAYLOAD_EXTERNALIZE_MIN_CHARS = 256 * 1024;

export const TRANSCRIPT_ATTACHMENTS_DIRNAME = "attachments";

const MARKER_PATTERN = /^agentlink-external-payload:v1:([0-9a-f]{64}):(\d+)$/;

export interface ExternalizedTranscript {
  messages: AgentMessage[];
  /**
   * Every externalized payload referenced by the returned messages,
   * content-hash → exact original string. Values are references to the
   * in-memory strings, not copies.
   */
  payloads: Map<string, string>;
}

export function buildTranscriptPayloadMarker(
  hash: string,
  length: number,
): string {
  return `${TRANSCRIPT_PAYLOAD_MARKER_PREFIX}${hash}:${length}`;
}

export function parseTranscriptPayloadMarker(
  value: string,
): { hash: string; length: number } | null {
  if (!value.startsWith(TRANSCRIPT_PAYLOAD_MARKER_PREFIX)) return null;
  const match = MARKER_PATTERN.exec(value);
  if (!match) return null;
  return { hash: match[1]!, length: Number(match[2]) };
}

/**
 * Marker cache keyed by the payload's container object and property key.
 * Transcript block objects and their strings are stable across persist ticks
 * (streaming appends new blocks; it never rewrites old payload strings), so
 * after the first save each multi-MB string is recognized by reference
 * equality instead of being re-hashed. Reference mismatch just re-hashes —
 * correctness never depends on the cache.
 */
const markerCache = new WeakMap<
  object,
  Map<string | number, { value: string; marker: string; hash: string }>
>();

function externalizeString(
  value: string,
  container: object,
  key: string | number,
  payloads: Map<string, string>,
): string {
  if (value.length < TRANSCRIPT_PAYLOAD_EXTERNALIZE_MIN_CHARS) return value;
  // A marker left behind by a rehydration miss stays a marker (it is far
  // below the size threshold anyway, but be explicit for clarity).
  if (parseTranscriptPayloadMarker(value)) return value;

  let cacheForContainer = markerCache.get(container);
  const cached = cacheForContainer?.get(key);
  if (cached && cached.value === value) {
    payloads.set(cached.hash, value);
    return cached.marker;
  }

  const hash = crypto.createHash("sha256").update(value, "utf8").digest("hex");
  const marker = buildTranscriptPayloadMarker(hash, value.length);
  if (!cacheForContainer) {
    cacheForContainer = new Map();
    markerCache.set(container, cacheForContainer);
  }
  cacheForContainer.set(key, { value, marker, hash });
  payloads.set(hash, value);
  return marker;
}

type Transform = (
  value: unknown,
  container: object,
  key: string | number,
) => unknown;

function transformValue(
  value: unknown,
  container: object,
  key: string | number,
  onString: Transform,
): unknown {
  if (typeof value === "string") return onString(value, container, key);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry, index) => {
      const transformed = transformValue(entry, value, index, onString);
      if (transformed !== entry) changed = true;
      return transformed;
    });
    return changed ? next : value;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      const transformed = transformValue(entryValue, value, entryKey, onString);
      if (transformed !== entryValue) changed = true;
      next[entryKey] = transformed;
    }
    return changed ? next : value;
  }
  return value;
}

/**
 * Returns messages with every oversized string replaced by a marker, plus the
 * payload map to persist. Unchanged subtrees are returned by reference, so
 * the copy cost is proportional to the changed structure, not transcript
 * size.
 */
export function externalizeTranscriptPayloads(
  messages: AgentMessage[],
): ExternalizedTranscript {
  const payloads = new Map<string, string>();
  const onString: Transform = (value, container, key) =>
    externalizeString(value as string, container, key, payloads);
  const transformed = transformValue(
    messages,
    { messages },
    "messages",
    onString,
  ) as AgentMessage[];
  return { messages: transformed, payloads };
}

/**
 * Replaces markers with their stored payloads. A payload that cannot be read
 * (or whose length disagrees with the marker) leaves the marker in place —
 * the transcript stays structurally valid and the reference is preserved.
 */
export function rehydrateTranscriptPayloads(
  messages: AgentMessage[],
  readPayload: (hash: string) => string | null,
): AgentMessage[] {
  const onString: Transform = (value) => {
    const marker = parseTranscriptPayloadMarker(value as string);
    if (!marker) return value;
    const payload = readPayload(marker.hash);
    if (payload === null || payload.length !== marker.length) return value;
    return payload;
  };
  return transformValue(
    messages,
    { messages },
    "messages",
    onString,
  ) as AgentMessage[];
}
