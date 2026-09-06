export interface CodexTurnRoutingBinding {
  value?: string;
  disabled: boolean;
}

/** Runtime-only: create once per turn, never serialize into session state. */
export class CodexTurnState {
  #identity: string | undefined;
  #binding: CodexTurnRoutingBinding | undefined;

  bind(
    sessionId: string,
    authIdentity: string,
    model: string,
  ): CodexTurnRoutingBinding {
    const identity = JSON.stringify([sessionId, authIdentity, model]);
    if (identity !== this.#identity) {
      this.#identity = identity;
      this.#binding = { disabled: false };
    }
    return this.#binding!;
  }
}

export interface CodexTurnRouting {
  sessionId: string;
  /** Private credential/endpoint identity, not a header or telemetry field. */
  authIdentity: string;
  turnState: CodexTurnState;
}

export const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";

export function captureCodexTurnState(
  binding: CodexTurnRoutingBinding,
  value: string | null,
): void {
  if (
    !binding.disabled &&
    binding.value === undefined &&
    value &&
    value.length <= 8192 &&
    /^[\x20-\x7e]+$/.test(value)
  ) {
    binding.value = value;
  }
}

export function isCodexRoutingRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const shape = error as {
    status?: number;
    message?: string;
    param?: string;
    error?: { param?: string; message?: string };
  };
  if (shape.status !== 400 && shape.status !== 422) return false;
  const param = shape.param ?? shape.error?.param;
  if (param === "prompt_cache_key" || param === CODEX_TURN_STATE_HEADER)
    return true;
  const message = `${shape.message ?? ""} ${shape.error?.message ?? ""}`;
  return (
    /(?:prompt_cache_key|x-codex-turn-state)/i.test(message) &&
    /(?:unsupported|not supported|unknown|unrecognized|unexpected|invalid|not allowed)/i.test(
      message,
    )
  );
}
