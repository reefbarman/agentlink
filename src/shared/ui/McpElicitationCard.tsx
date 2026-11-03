import { useState } from "preact/hooks";

import {
  createMcpElicitationInitialValues,
  validateAndCoerceMcpElicitationValues,
  type McpElicitationFieldErrors,
  type McpElicitationValues,
  type McpFormElicitationRequest,
  type McpFormElicitationResponse,
} from "@agentlink/protocol/mcp-elicitation";
import type { McpUrlElicitationRequest } from "@agentlink/protocol/mcp-url-elicitation";
import { McpElicitationFormControls } from "./McpElicitationFormControls";

/** Outcome of submitting a response; surfaces may validate remotely. */
export interface McpElicitationRespondResult {
  ok: boolean;
  errors?: McpElicitationFieldErrors;
  error?: string;
}

export interface McpFormElicitationCardProps {
  request: McpFormElicitationRequest;
  onRespond: (
    response: McpFormElicitationResponse,
  ) =>
    | Promise<McpElicitationRespondResult>
    | McpElicitationRespondResult
    | void;
  idPrefix?: string;
}

const DECLINE_TITLE = "Tell the server you won't provide this";
const CANCEL_TITLE = "Dismiss without answering";

/**
 * Chat Activity Shelf card for an MCP form request. Cancel, Decline and
 * Submit map to the three MCP elicitation actions; they are not synonyms.
 */
export function McpFormElicitationCard({
  request,
  onRespond,
  idPrefix = "mcp-elicitation",
}: McpFormElicitationCardProps) {
  const [values, setValues] = useState<McpElicitationValues>(() =>
    createMcpElicitationInitialValues(request.fields),
  );
  const [errors, setErrors] = useState<McpElicitationFieldErrors>({});
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const respond = async (response: McpFormElicitationResponse) => {
    setSubmitting(true);
    setSubmitError("");
    try {
      const result = await onRespond(response);
      if (result && !result.ok) {
        setErrors(result.errors ?? {});
        setSubmitError(result.error ?? "The response could not be submitted.");
      }
    } catch {
      setSubmitError("The response could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  };

  const accept = () => {
    const validation = validateAndCoerceMcpElicitationValues(
      request.fields,
      values,
    );
    if (!validation.ok) {
      setErrors(validation.errors);
      setSubmitError("Check the highlighted fields and try again.");
      return;
    }
    setErrors({});
    void respond({
      id: request.id,
      action: "accept",
      values: validation.values,
    });
  };

  return (
    <form
      class="mcp-elicit-card"
      aria-label={`${request.serverName} is asking for input`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!submitting) accept();
      }}
    >
      <McpElicitationCardHeader
        icon="list-selection"
        eyebrow="Input requested"
        serverName={request.serverName}
      />
      <p class="mcp-elicit-card-message">{request.message}</p>
      {request.fields.length > 0 && (
        <McpElicitationFormControls
          fields={request.fields}
          values={values}
          errors={errors}
          disabled={submitting}
          idPrefix={`${idPrefix}-${request.id}`}
          onChange={(name, value) => {
            setValues((current) => ({ ...current, [name]: value }));
            setErrors((current) => {
              if (!current[name]) return current;
              const next = { ...current };
              delete next[name];
              return next;
            });
            setSubmitError("");
          }}
        />
      )}
      {submitError && (
        <p class="mcp-elicitation-error mcp-elicit-card-error" role="alert">
          {submitError}
        </p>
      )}
      <div class="mcp-elicit-card-actions">
        <button
          type="button"
          class="mcp-elicit-btn mcp-elicit-btn-ghost"
          disabled={submitting}
          title={CANCEL_TITLE}
          onClick={() => void respond({ id: request.id, action: "cancel" })}
        >
          Cancel
        </button>
        <span class="mcp-elicit-card-actions-spacer" />
        <button
          type="button"
          class="mcp-elicit-btn mcp-elicit-btn-secondary"
          disabled={submitting}
          title={DECLINE_TITLE}
          onClick={() => void respond({ id: request.id, action: "decline" })}
        >
          Decline
        </button>
        <button
          type="submit"
          class="mcp-elicit-btn mcp-elicit-btn-primary"
          disabled={submitting}
        >
          {submitting ? "Submitting…" : "Submit"}
        </button>
      </div>
    </form>
  );
}

export interface McpUrlElicitationCardProps {
  request: McpUrlElicitationRequest;
  onRespond: (id: string, action: "accept" | "decline" | "cancel") => void;
  /** Embedded hosts that cannot open external windows disable Open. */
  externalBrowserUnavailable?: boolean;
}

/** Chat Activity Shelf card for an MCP URL (browser step) request. */
export function McpUrlElicitationCard({
  request,
  onRespond,
  externalBrowserUnavailable = false,
}: McpUrlElicitationCardProps) {
  return (
    <section
      class="mcp-elicit-card mcp-elicit-card-url"
      aria-label={`${request.serverName} is asking you to open a page`}
    >
      <McpElicitationCardHeader
        icon="link-external"
        eyebrow="Browser step requested"
        serverName={request.serverName}
      />
      <p class="mcp-elicit-card-message">{request.message}</p>
      <div class="mcp-elicit-card-url-box">
        <span class="mcp-elicit-card-url-origin">{request.origin}</span>
        <code class="mcp-elicit-card-url-full">{request.url}</code>
      </div>
      <p
        class={`mcp-elicit-card-notice${request.isLocalAddress ? " mcp-elicit-card-notice-danger" : ""}`}
      >
        <i
          class={`codicon codicon-${request.isLocalAddress ? "warning" : "shield"}`}
          aria-hidden="true"
        />
        <span>
          {request.isLocalAddress
            ? "This page is on a local or private network address. Only open it if you trust this server."
            : "Only open this page if you trust this server and expected this step."}
        </span>
      </p>
      {externalBrowserUnavailable && (
        <p class="mcp-elicit-card-notice" role="status">
          <i class="codicon codicon-info" aria-hidden="true" />
          <span>
            This view can't open external windows. Finish this step in VS Code
            or the browser view.
          </span>
        </p>
      )}
      <div class="mcp-elicit-card-actions">
        <button
          type="button"
          class="mcp-elicit-btn mcp-elicit-btn-ghost"
          title={CANCEL_TITLE}
          onClick={() => onRespond(request.id, "cancel")}
        >
          Cancel
        </button>
        <span class="mcp-elicit-card-actions-spacer" />
        <button
          type="button"
          class="mcp-elicit-btn mcp-elicit-btn-secondary"
          title={DECLINE_TITLE}
          onClick={() => onRespond(request.id, "decline")}
        >
          Decline
        </button>
        <button
          type="button"
          class="mcp-elicit-btn mcp-elicit-btn-primary"
          disabled={externalBrowserUnavailable}
          onClick={() => onRespond(request.id, "accept")}
        >
          Open page
        </button>
      </div>
    </section>
  );
}

function McpElicitationCardHeader({
  icon,
  eyebrow,
  serverName,
}: {
  icon: string;
  eyebrow: string;
  serverName: string;
}) {
  return (
    <div class="mcp-elicit-card-header">
      <span class="mcp-elicit-card-icon" aria-hidden="true">
        <i class={`codicon codicon-${icon}`} />
      </span>
      <span class="mcp-elicit-card-eyebrow">{eyebrow}</span>
      <span class="mcp-elicit-card-server" title="MCP server">
        <i class="codicon codicon-server" aria-hidden="true" />
        {serverName}
      </span>
    </div>
  );
}
