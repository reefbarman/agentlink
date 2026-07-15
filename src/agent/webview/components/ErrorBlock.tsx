import { ErrorNotice } from "./ErrorNotice";

interface ErrorBlockProps {
  error: string;
  retryable: boolean;
  code?: string;
  actions?: {
    signIn?: boolean;
    signInAnotherAccount?: boolean;
    condense?: boolean;
  };
  onRetry?: () => void;
  onSignIn?: () => void;
  onSignInAnotherAccount?: () => void;
  onCondense?: () => void;
}

function isAuthError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("authentication_error") ||
    lower.includes("invalid x-api-key") ||
    lower.includes("invalid api key") ||
    // Word boundaries so digit runs inside provider error bodies (e.g. SVG
    // path data in a Cloudflare HTML page) don't match as a 401 status.
    (/\b401\b/.test(lower) && !lower.includes("tool"))
  );
}

function getErrorTitle(
  error: string,
  options: {
    authError: boolean;
    oauthExhausted: boolean;
    contextWindowExceeded: boolean;
  },
): string {
  if (options.oauthExhausted) return "Usage limit reached";
  if (options.authError) return "Sign-in required";
  if (options.contextWindowExceeded) return "Context window full";

  const lower = error.toLowerCase();
  if (lower.includes("rate_limit") || lower.includes("429")) {
    return "Rate limit reached";
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "Request timed out";
  }
  if (
    lower.includes("connection") ||
    lower.includes("eaddrnotavail") ||
    lower.includes("econn") ||
    lower.includes("fetch failed")
  ) {
    return "Connection failed";
  }
  return "Request failed";
}

export function ErrorBlock({
  error,
  retryable,
  code,
  actions,
  onRetry,
  onSignIn,
  onSignInAnotherAccount,
  onCondense,
}: ErrorBlockProps) {
  const authError = isAuthError(error) || Boolean(actions?.signIn);
  const oauthExhausted =
    code === "oauth_usage_limit_exhausted" ||
    Boolean(actions?.signInAnotherAccount);
  const contextWindowExceeded =
    code === "context_window_exceeded" || Boolean(actions?.condense);
  const title = getErrorTitle(error, {
    authError,
    oauthExhausted,
    contextWindowExceeded,
  });
  const hint = oauthExhausted
    ? "All signed-in Codex accounts have hit usage limits. Add another account or retry later."
    : authError
      ? "Sign in to authenticate your API access."
      : contextWindowExceeded
        ? "Conversation exceeded the model context window. Condense and retry."
        : retryable
          ? "This may be temporary. You can retry the request."
          : onRetry
            ? "Retry to run the last request again."
            : undefined;
  const hasActions = Boolean(
    (authError && onSignIn) ||
    (oauthExhausted && onSignInAnotherAccount) ||
    (contextWindowExceeded && onCondense) ||
    onRetry,
  );

  return (
    <ErrorNotice
      tone="error"
      title={title}
      hint={hint}
      details={[error]}
      actions={
        hasActions ? (
          <>
            {authError && onSignIn && (
              <button
                type="button"
                class="error-sign-in-btn"
                onClick={onSignIn}
              >
                <i class="codicon codicon-key" />
                Sign in
              </button>
            )}
            {oauthExhausted && onSignInAnotherAccount && (
              <button
                type="button"
                class="error-sign-in-btn"
                onClick={onSignInAnotherAccount}
              >
                <i class="codicon codicon-account-add" />
                Sign in another account
              </button>
            )}
            {contextWindowExceeded && onCondense && (
              <button
                type="button"
                class="error-retry-btn"
                onClick={onCondense}
              >
                <i class="codicon codicon-collapse-all" />
                Condense
              </button>
            )}
            {onRetry && (
              <button type="button" class="error-retry-btn" onClick={onRetry}>
                <i class="codicon codicon-refresh" />
                Retry
              </button>
            )}
          </>
        ) : undefined
      }
    />
  );
}
