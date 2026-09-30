import {
  MAX_QUOTA_READING_AGE_MS,
  parseMeridianQuotaResponse,
} from "./meridianQuota.js";

import type { NormalizedOpenAiCompatibleConnection } from "@agentlink/core/openai-compatible";
import type { OpenAiCompatibleSecretResolver } from "./OpenAiCompatibleProvider.js";
import type { ProviderUsageAdapter } from "../ProviderUsageService.js";
import type { ProviderUsageEntry } from "../../../shared/providerUsage.js";
import { getOpenAiCompatibleSecretKey } from "../../openAiCompatibleSecrets.js";

const SUCCESS_CACHE_MS = 30_000;
const REQUEST_DEADLINE_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_FAILURE_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const MAX_PARALLEL_QUERIES = 4;

type QuotaFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenAiCompatibleQuotaServiceOptions {
  getConnections(): readonly NormalizedOpenAiCompatibleConnection[];
  isProviderEnabled(providerId: string): boolean;
  secrets: OpenAiCompatibleSecretResolver;
  fetch?: QuotaFetch;
  now?: () => number;
}

class QuotaRequestError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

interface QuotaCacheEntry {
  lastBody?: unknown;
  lastSuccessAtMs?: number;
  suppressedUntilMs?: number;
  lastFailure?: string;
}

/**
 * On-demand subscription quota for OpenAI-compatible connections that
 * explicitly configure a `quota` source. Never polls: every network request
 * comes from opening or refreshing a usage panel.
 */
export class OpenAiCompatibleQuotaService {
  private generation = 0;
  private readonly cache = new Map<string, QuotaCacheEntry>();
  private readonly inflight = new Map<string, Promise<void>>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly fetchImpl: QuotaFetch;
  private readonly now: () => number;

  constructor(private readonly options: OpenAiCompatibleQuotaServiceOptions) {
    this.fetchImpl =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  /** Drops cached readings after configuration or credential changes. */
  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
    this.inflight.clear();
  }

  createAdapters(): ProviderUsageAdapter[] {
    return this.options
      .getConnections()
      .filter(
        (connection) =>
          connection.quota !== undefined &&
          this.options.isProviderEnabled(connection.providerId),
      )
      .map((connection) => ({
        providerId: connection.providerId,
        providerName: connection.displayName,
        query: () => this.query(connection),
      }));
  }

  private async query(
    connection: NormalizedOpenAiCompatibleConnection,
  ): Promise<Omit<ProviderUsageEntry, "providerId" | "providerName">> {
    const quota = connection.quota;
    if (!quota) return { available: false, reason: "Usage is not configured." };
    if (quota.status === "invalid") {
      return {
        available: false,
        reason: `Usage reporting is misconfigured: ${quota.reason}`,
      };
    }
    const key = JSON.stringify([
      connection.providerId,
      quota.format,
      quota.url,
      quota.authKey ?? null,
    ]);
    const entry = this.cache.get(key);
    const now = this.now();
    const fresh =
      entry?.lastSuccessAtMs !== undefined &&
      now - entry.lastSuccessAtMs < SUCCESS_CACHE_MS;
    const suppressed =
      entry?.suppressedUntilMs !== undefined && now < entry.suppressedUntilMs;
    if (!fresh && !suppressed) {
      let pending = this.inflight.get(key);
      if (!pending) {
        pending = this.refresh(key, quota.url, quota.authKey).finally(() => {
          if (this.inflight.get(key) === pending) this.inflight.delete(key);
        });
        this.inflight.set(key, pending);
      }
      await pending;
    }
    return this.buildEntry(this.cache.get(key));
  }

  private buildEntry(
    entry: QuotaCacheEntry | undefined,
  ): Omit<ProviderUsageEntry, "providerId" | "providerName"> {
    const now = this.now();
    const failed =
      entry?.lastFailure !== undefined &&
      (entry.lastSuccessAtMs === undefined ||
        (entry.suppressedUntilMs ?? 0) > entry.lastSuccessAtMs);
    const retryNotice =
      entry?.suppressedUntilMs !== undefined && entry.suppressedUntilMs > now
        ? ` Retry available in about ${Math.ceil((entry.suppressedUntilMs - now) / 1_000)}s.`
        : "";
    const usableBody =
      entry?.lastSuccessAtMs !== undefined &&
      now - entry.lastSuccessAtMs <= MAX_QUOTA_READING_AGE_MS
        ? entry.lastBody
        : undefined;

    if (usableBody === undefined) {
      return {
        available: false,
        reason: `${entry?.lastFailure ?? "Usage is unavailable."}${retryNotice}`,
      };
    }
    const accounts = parseMeridianQuotaResponse(usableBody, {
      nowMs: now,
      forceStale: failed,
    });
    return {
      available: true,
      accounts,
      ...(failed
        ? {
            notice: `Showing the last successful reading. ${entry?.lastFailure ?? ""}${retryNotice}`,
          }
        : accounts.length === 0
          ? { notice: "Meridian reported no profiles." }
          : {}),
    };
  }

  private async refresh(
    key: string,
    url: string,
    authKey: string | undefined,
  ): Promise<void> {
    const generation = this.generation;
    await this.acquire();
    try {
      const body = await this.fetchQuota(url, authKey);
      parseMeridianQuotaResponse(body, { nowMs: this.now() });
      if (generation !== this.generation) return;
      this.cache.set(key, { lastBody: body, lastSuccessAtMs: this.now() });
    } catch (error) {
      if (generation !== this.generation) return;
      const previous = this.cache.get(key) ?? {};
      const retryAfterMs =
        error instanceof QuotaRequestError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : DEFAULT_FAILURE_BACKOFF_MS;
      this.cache.set(key, {
        ...previous,
        suppressedUntilMs: this.now() + retryAfterMs,
        lastFailure:
          error instanceof QuotaRequestError || error instanceof Error
            ? classifyFailure(error)
            : "The quota endpoint could not be reached.",
      });
    } finally {
      this.release();
    }
  }

  private async fetchQuota(
    url: string,
    authKey: string | undefined,
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (authKey) {
      const secret = (
        await this.options.secrets.get(getOpenAiCompatibleSecretKey(authKey))
      )?.trim();
      if (!secret) {
        throw new QuotaRequestError(
          `The named credential "${authKey}" is not set.`,
        );
      }
      headers.authorization = `Bearer ${secret}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        throw new QuotaRequestError(
          controller.signal.aborted
            ? "The quota endpoint did not respond in time."
            : "The quota endpoint could not be reached.",
        );
      }
      if (
        response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400)
      ) {
        throw new QuotaRequestError(
          "The quota endpoint redirected, which is not allowed.",
        );
      }
      if (!response.ok) throw statusError(response);
      const text = await readBounded(response);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new QuotaRequestError(
          "The quota endpoint returned an unrecognised response.",
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < MAX_PARALLEL_QUERIES) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }
}

function classifyFailure(error: Error): string {
  if (error instanceof QuotaRequestError) return error.message;
  if (error.name === "MeridianQuotaParseError") return error.message;
  return "The quota endpoint could not be reached.";
}

function statusError(response: Response): QuotaRequestError {
  const status = response.status;
  if (status === 401 || status === 403) {
    return new QuotaRequestError(
      "The quota endpoint rejected the configured credential.",
    );
  }
  if (status === 404 || status === 405) {
    return new QuotaRequestError(
      "The quota endpoint was not found. Check the URL and that Meridian supports /v1/usage/quota/all.",
    );
  }
  if (status === 429) {
    return new QuotaRequestError(
      "The quota endpoint is temporarily rate limited.",
      parseRetryAfterMs(response.headers.get("retry-after")),
    );
  }
  return new QuotaRequestError(
    `The quota endpoint returned an error (HTTP ${status}).`,
  );
}

export function parseRetryAfterMs(
  value: string | null,
  nowMs = Date.now(),
): number {
  if (!value) return DEFAULT_FAILURE_BACKOFF_MS;
  const trimmed = value.trim();
  let delayMs: number | undefined;
  if (/^\d+$/.test(trimmed)) {
    delayMs = Number(trimmed) * 1_000;
  } else {
    const date = Date.parse(trimmed);
    if (Number.isFinite(date)) delayMs = Math.max(0, date - nowMs);
  }
  if (delayMs === undefined || !Number.isFinite(delayMs)) {
    return DEFAULT_FAILURE_BACKOFF_MS;
  }
  return Math.min(Math.max(delayMs, 1_000), MAX_RETRY_AFTER_MS);
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new QuotaRequestError("The quota response was too large.");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new QuotaRequestError("The quota response was too large.");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
