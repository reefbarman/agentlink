import {
  DEFAULT_TYPESAFE_GUARDIAN_MODEL,
  normalizeTypeSafeFirstPassThreshold,
  redactSensitiveText,
} from "./typeSafeGuardianShadow.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_INPUT_BYTES = 48 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface TypeSafeActionFirstPassOptions {
  getConfig(): {
    enabled: boolean;
    threshold?: number;
    model?: string;
    timeoutMs?: number;
  };
  getApiKey(): Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
}

export interface TypeSafeActionFirstPassQuestion {
  type: "noul";
  instructions: string;
}

export interface TypeSafeActionFirstPassRequest {
  signal?: AbortSignal;
  state: unknown;
  policy: string;
  questions: Record<string, TypeSafeActionFirstPassQuestion>;
}

export interface TypeSafeActionFirstPassResponse {
  config: ReturnType<TypeSafeActionFirstPassOptions["getConfig"]>;
  threshold: number;
  model: string;
  answers: Record<string, unknown>;
}

export async function requestTypeSafeActionFirstPass(
  options: TypeSafeActionFirstPassOptions,
  input: TypeSafeActionFirstPassRequest,
): Promise<TypeSafeActionFirstPassResponse | undefined> {
  let config: ReturnType<typeof options.getConfig>;
  try {
    config = options.getConfig();
  } catch {
    return undefined;
  }
  if (!config.enabled || input.signal?.aborted) return undefined;

  const timeoutMs = normalizeTimeout(config.timeoutMs);
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let settled = false;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      settled = true;
      resolve(undefined);
    }, timeoutMs);
    if (input.signal) {
      abortListener = () => {
        controller.abort();
        settled = true;
        resolve(undefined);
      };
      input.signal.addEventListener("abort", abortListener, { once: true });
    }
  });

  const work = (async (): Promise<
    TypeSafeActionFirstPassResponse | undefined
  > => {
    try {
      const key = await options.getApiKey();
      if (settled || signal.aborted || !key?.trim()) return undefined;

      const serialized = JSON.stringify(input.state);
      if (
        serialized === undefined ||
        new TextEncoder().encode(serialized).byteLength > MAX_INPUT_BYTES
      ) {
        return undefined;
      }
      const safe = redactTree(input.state);
      if (safe.redacted) return undefined;

      const model = config.model?.trim() || DEFAULT_TYPESAFE_GUARDIAN_MODEL;
      const response = await (options.fetch ?? globalThis.fetch)(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          state: safe.value,
          model,
          questions: Object.fromEntries(
            Object.entries(input.questions).map(([id, question]) => [
              id,
              {
                type: question.type,
                instructions: {
                  policy: input.policy,
                  question: question.instructions,
                },
              },
            ]),
          ),
        }),
        signal,
      });
      if (settled || signal.aborted || !response.ok) return undefined;
      if (
        !response.headers
          .get("content-type")
          ?.toLowerCase()
          .includes("application/json")
      ) {
        return undefined;
      }
      const body = await readBoundedBody(response);
      if (settled || signal.aborted || body === undefined) return undefined;
      const parsed: unknown = JSON.parse(body);
      const answers =
        isRecord(parsed) && isRecord(parsed.answers)
          ? parsed.answers
          : undefined;
      if (!answers) return undefined;
      return {
        config,
        threshold: normalizeTypeSafeFirstPassThreshold(config.threshold),
        model,
        answers,
      };
    } catch {
      return undefined;
    }
  })();

  try {
    return await Promise.race([work, deadline]);
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    if (input.signal && abortListener) {
      input.signal.removeEventListener("abort", abortListener);
    }
  }
}

export function isTypeSafeProbability(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

async function readBoundedBody(
  response: Response,
): Promise<string | undefined> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function redactTree(value: unknown): { value: unknown; redacted: boolean } {
  if (typeof value === "string") {
    const result = redactSensitiveText(value);
    return { value: result.text, redacted: result.redacted };
  }
  if (Array.isArray(value)) {
    const items = value.map(redactTree);
    return {
      value: items.map((item) => item.value),
      redacted: items.some((item) => item.redacted),
    };
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).map(
      ([key, item]) => [key, redactTree(item)] as const,
    );
    const sensitiveKey =
      /(?:api.?key|access.?key|private.?key|token|secret|password|credential)/i;
    const sensitiveValue = entries.some(
      ([key, item]) =>
        sensitiveKey.test(key) &&
        item.value !== undefined &&
        item.value !== null &&
        item.value !== "",
    );
    return {
      value: Object.fromEntries(
        entries.map(([key, item]) => [key, item.value]),
      ),
      redacted: sensitiveValue || entries.some(([, item]) => item.redacted),
    };
  }
  return { value, redacted: false };
}

function normalizeTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(60_000, Math.max(1, Math.round(value)))
    : DEFAULT_TIMEOUT_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
