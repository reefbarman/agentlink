import type { McpUrlElicitationRequest } from "../../../shared/mcpUrlElicitation";

interface UrlElicitationModalProps {
  request: McpUrlElicitationRequest;
  onAccept: (id: string, url: string) => void;
  onDecline: (id: string) => void;
  onCancel: (id: string) => void;
}

export function UrlElicitationModal({
  request,
  onAccept,
  onDecline,
  onCancel,
}: UrlElicitationModalProps) {
  return (
    <div class="elicit-overlay">
      <div class="elicit-modal elicit-url-modal">
        <div class="elicit-header">
          <i class="codicon codicon-link-external" />
          <span class="elicit-server">{request.serverName}</span>
        </div>
        <p class="elicit-message">{request.message}</p>
        <div class="elicit-url-warning">
          <strong>External browser step requested</strong>
          <span>
            Only continue if you trust this MCP server and expected this flow.
          </span>
        </div>
        {request.isLocalAddress && (
          <div class="elicit-url-warning elicit-url-warning-danger">
            This URL points at a local or private network address. Make sure the
            server is trusted before opening it.
          </div>
        )}
        <div class="elicit-url-details">
          <div>
            <span class="elicit-label">Origin</span>
            <code>{request.origin}</code>
          </div>
          <div>
            <span class="elicit-label">Full URL</span>
            <code>{request.url}</code>
          </div>
        </div>
        <div class="elicit-actions">
          <button
            class="elicit-btn elicit-btn-cancel"
            onClick={() => onCancel(request.id)}
            type="button"
          >
            Cancel
          </button>
          <button
            class="elicit-btn elicit-btn-cancel"
            onClick={() => onDecline(request.id)}
            type="button"
          >
            Decline
          </button>
          <button
            class="elicit-btn elicit-btn-submit"
            onClick={() => onAccept(request.id, request.url)}
            type="button"
          >
            Open URL
          </button>
        </div>
      </div>
    </div>
  );
}
