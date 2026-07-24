import {
  validateAndCoerceMcpElicitationValues,
  type McpElicitationFieldErrors,
  type McpElicitationValues,
  type McpFormElicitationInput,
  type McpFormElicitationRequest,
  type McpFormElicitationResponse,
} from "../shared/mcpElicitation.js";
import { randomId } from "../shared/randomId.js";

interface PendingFormElicitation {
  request: McpFormElicitationRequest;
  sessionId: string;
  resolve: (values: McpElicitationValues) => void;
  cancel: () => void;
}

export type McpFormElicitationSubmitResult =
  | { ok: true }
  | { ok: false; reason: "stale_request" }
  | {
      ok: false;
      reason: "invalid_values";
      errors: McpElicitationFieldErrors;
    };

export interface McpFormElicitationCoordinatorOptions {
  publishRequest: (
    sessionId: string,
    request: McpFormElicitationRequest,
  ) => void;
  publishCleared: (sessionId: string, id: string) => void;
  createId?: () => string;
}

export class McpFormElicitationCoordinator {
  private active: PendingFormElicitation | undefined;
  private readonly queue: PendingFormElicitation[] = [];

  constructor(private readonly options: McpFormElicitationCoordinatorOptions) {}

  enqueue(
    input: McpFormElicitationInput,
    callbacks: {
      sessionId?: string;
      resolve: (values: McpElicitationValues) => void;
      cancel: () => void;
    },
  ): McpFormElicitationRequest {
    const sessionId = callbacks.sessionId?.trim();
    if (!sessionId) {
      throw new Error("MCP form elicitation requires a session ID");
    }
    const request: McpFormElicitationRequest = {
      ...input,
      id: this.options.createId?.() ?? `elicit_${randomId()}`,
    };
    this.queue.push({ request, ...callbacks, sessionId });
    this.publishNext();
    return request;
  }

  getActiveRequest(): McpFormElicitationRequest | undefined {
    return this.active ? { ...this.active.request } : undefined;
  }

  submit(response: McpFormElicitationResponse): McpFormElicitationSubmitResult {
    const pending = this.active;
    if (!pending || pending.request.id !== response.id) {
      return { ok: false, reason: "stale_request" };
    }

    if (response.action === "accept") {
      const validation = validateAndCoerceMcpElicitationValues(
        pending.request.fields,
        response.values,
      );
      if (!validation.ok) {
        return {
          ok: false,
          reason: "invalid_values",
          errors: validation.errors,
        };
      }
      this.finishActive(() => pending.resolve(validation.values));
      return { ok: true };
    }

    this.finishActive(pending.cancel);
    return { ok: true };
  }

  cancelSession(sessionId: string): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const pending = this.queue[index];
      if (pending?.sessionId !== sessionId) continue;
      this.queue.splice(index, 1);
      pending.cancel();
    }

    if (this.active?.sessionId === sessionId) {
      const pending = this.active;
      this.finishActive(pending.cancel);
    }
  }

  dispose(): void {
    const active = this.active;
    this.active = undefined;
    if (active) {
      this.options.publishCleared(active.sessionId, active.request.id);
      active.cancel();
    }
    for (const pending of this.queue.splice(0)) pending.cancel();
  }

  private finishActive(complete: () => void): void {
    const pending = this.active;
    if (!pending) return;
    this.active = undefined;
    this.options.publishCleared(pending.sessionId, pending.request.id);
    complete();
    this.publishNext();
  }

  private publishNext(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    this.options.publishRequest(next.sessionId, next.request);
  }
}
