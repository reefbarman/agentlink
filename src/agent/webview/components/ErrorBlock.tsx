interface ErrorBlockProps {
  error: string;
  retryable: boolean;
  onRetry?: () => void;
}

export function ErrorBlock({ error, retryable, onRetry }: ErrorBlockProps) {
  return (
    <div class="error-block">
      <div class="error-icon">
        <i class="codicon codicon-error" />
      </div>
      <div class="error-body">
        <span class="error-message">{error}</span>
        {retryable && (
          <span class="error-hint">
            This error may be transient. Try again.
          </span>
        )}
        {retryable && onRetry && (
          <button class="error-retry-btn" onClick={onRetry}>
            <i class="codicon codicon-refresh" />
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
