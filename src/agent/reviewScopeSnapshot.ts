// The review scope snapshot lives in core so every surface hands reviewers
// the same validated target.
export {
  assertReviewScopeAvailable,
  captureReviewScope,
  type CaptureReviewScopeOptions,
  type ReviewScopeHandoff,
} from "@agentlink/core/review-scope";
