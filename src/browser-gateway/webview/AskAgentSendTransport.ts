import type { GatewaySnapshot } from "./BrowserGatewayApp";
import { randomId } from "../../shared/randomId";

export interface AskAgentSendResponse {
  ok?: boolean;
  queued?: boolean;
  interjected?: boolean;
  error?: string;
  snapshot?: GatewaySnapshot;
}

export const ASK_AGENT_SEND_ACK_TIMEOUT_MS = 15_000;

export class AskAgentSendUnconfirmedError extends Error {
  constructor() {
    super(
      "Delivery not confirmed. Retry this message to check again without sending it twice.",
    );
  }
}

/** Retry delivery, never the model turn. Uncertain retries retain their message id. */
export class AskAgentSendTransport {
  private readonly messages = new Map<string, { id: string; body?: string }>();
  private readonly requests = new Map<
    string,
    Promise<{ status: number; body: AskAgentSendResponse }>
  >();

  discardDraft(): void {
    // In-flight requests retain their own frozen payload. Editing the draft
    // starts a new submission, even if its text later matches an older one.
    this.messages.clear();
  }

  reserveMessageId(key: string): string {
    let message = this.messages.get(key);
    if (!message) {
      if (this.messages.size >= 16) throw new AskAgentSendUnconfirmedError();
      message = { id: randomId() };
      this.messages.set(key, message);
    }
    return message.id;
  }

  send(
    key: string,
    payload: Record<string, unknown>,
    authToken: string,
  ): Promise<{ status: number; body: AskAgentSendResponse }> {
    const id = this.reserveMessageId(key);
    const existing = this.requests.get(id);
    if (existing) return existing;
    if (this.requests.size >= 16) throw new AskAgentSendUnconfirmedError();
    const message = this.messages.get(key)!;
    message.body ??= JSON.stringify({ ...payload, id, acknowledge: true });
    const request = this.deliver(message.body, authToken).then((result) => {
      // A network failure or server error is not proof of non-delivery. Keep
      // the id so retrying the restored draft cannot start a second turn.
      if (this.messages.get(key) === message) this.messages.delete(key);
      return result;
    });
    this.requests.set(id, request);
    void request.finally(() => this.requests.delete(id)).catch(() => {});
    return request;
  }

  private async deliver(
    body: string,
    authToken: string,
  ): Promise<{ status: number; body: AskAgentSendResponse }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            const response = await fetch("/api/ask-agent/send", {
              method: "POST",
              credentials: "same-origin",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${authToken}`,
              },
              signal: controller.signal,
              body,
            });
            const result = (await response.json()) as AskAgentSendResponse;
            if (response.status >= 500) throw new Error("send_unconfirmed");
            return { status: response.status, body: result };
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new AskAgentSendUnconfirmedError());
            }, ASK_AGENT_SEND_ACK_TIMEOUT_MS);
          }),
        ]);
      } catch {
        // The helper deduplicates this exact session/message id, including
        // requests still preparing a turn. Never generate a new id here.
        controller.abort();
      } finally {
        clearTimeout(timer);
      }
    }
    throw new AskAgentSendUnconfirmedError();
  }
}
