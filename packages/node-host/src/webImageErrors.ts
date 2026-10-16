/** Stable failure categories reported by the web image tools. */
export type WebImageErrorCode =
  | "disabled"
  | "unsupported_url"
  | "blocked_destination"
  | "blocked_domain"
  | "image_retrieval_proxy_unsupported"
  | "approval_rejected"
  | "cancelled"
  | "candidate_unavailable"
  | "timeout"
  | "rate_limited"
  | "turn_budget_exceeded"
  | "too_many_redirects"
  | "fetch_failed"
  | "not_html"
  | "no_candidates"
  | "unsupported_format"
  | "invalid_image"
  | "pixel_limit"
  | "byte_limit";

export class WebImageError extends Error {
  constructor(
    readonly code: WebImageErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WebImageError";
  }
}
