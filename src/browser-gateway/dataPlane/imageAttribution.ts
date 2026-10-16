import type { ImageAttribution } from "@agentlink/protocol/tool-result";

const MAX_URL = 4096;
const MAX_TEXT = 500;
const MAX_LABEL = 200;
const ORIGINS = new Set(["web_page", "web_url"]);
const EXTRACTIONS = new Set([
  "json_ld",
  "open_graph",
  "twitter",
  "html_image",
  "direct_url",
]);

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // oxlint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_URL) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function dimension(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 100_000
    ? value
    : undefined;
}

/**
 * Bounded, allowlisted copy of an image attribution for transport across the
 * browser relay. Invalid or unknown fields are dropped; a value without a
 * recognised origin yields undefined.
 */
export function boundedImageAttribution(
  value: unknown,
): ImageAttribution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.origin !== "string" || !ORIGINS.has(record.origin)) {
    return undefined;
  }
  const result: ImageAttribution = {
    origin: record.origin as ImageAttribution["origin"],
  };
  const sourceUrl = httpUrl(record.sourceUrl);
  const imageUrl = httpUrl(record.imageUrl);
  const title = text(record.title, MAX_TEXT);
  const alt = text(record.alt, MAX_TEXT);
  const creator = text(record.creator, MAX_LABEL);
  const license = text(record.license, MAX_LABEL);
  const width = dimension(record.width);
  const height = dimension(record.height);
  const retrievedAt = text(record.retrievedAt, 64);
  if (sourceUrl) result.sourceUrl = sourceUrl;
  if (imageUrl) result.imageUrl = imageUrl;
  if (record.sanitized === true) result.sanitized = true;
  if (title) result.title = title;
  if (alt) result.alt = alt;
  if (creator) result.creator = creator;
  if (license) result.license = license;
  if (
    typeof record.extraction === "string" &&
    EXTRACTIONS.has(record.extraction)
  ) {
    result.extraction = record.extraction as ImageAttribution["extraction"];
  }
  if (width) result.width = width;
  if (height) result.height = height;
  if (retrievedAt) result.retrievedAt = retrievedAt;
  return result;
}
