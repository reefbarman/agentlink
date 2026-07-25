const APPROX_CHARS_PER_TOKEN = 4;

/** Providers downscale large images; Claude tops out around ~1,600 tokens per image. */
export const ESTIMATED_TOKENS_PER_IMAGE = 1_500;

/** Ceiling for a single attached document's estimate — page-accurate costs are unknowable here. */
const MAX_ESTIMATED_DOCUMENT_TOKENS = 40_000;

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}

/**
 * Rough token estimate for an attached document from its base64 payload.
 * Decoded bytes are treated like text chars, capped because binary formats
 * (PDF images, compression) make byte counts a poor proxy for token cost.
 */
export function estimateDocumentTokens(base64: string): number {
  const decodedBytes = Math.floor(base64.length * 0.75);
  return Math.min(
    estimateTokensFromChars(decodedBytes),
    MAX_ESTIMATED_DOCUMENT_TOKENS,
  );
}
