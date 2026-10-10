import type { CodexFetch } from "./openaiClient.js";

/**
 * Modern ECDHE/AEAD TLS 1.2 cipher suites (TLS 1.3 suites are unaffected).
 * chatgpt.com's Cloudflare edge answers some runtimes' default ClientHello
 * (notably Electron's BoringSSL-based Node) with a managed challenge on the
 * transcription endpoint. This narrower, still-secure list is accepted.
 */
export const CODEX_TRANSCRIPTION_TLS_CIPHERS = [
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
].join(":");

export interface CreateCodexTranscriptionFetchOptions {
  /** OpenSSL cipher list; defaults to `CODEX_TRANSCRIPTION_TLS_CIPHERS`. */
  readonly ciphers?: string;
  /**
   * Environment read once for `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` (and
   * lowercase forms). Defaults to `process.env`.
   */
  readonly env?: NodeJS.ProcessEnv;
}

type Undici = typeof import("undici");

function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy,
  );
}

/**
 * Creates a fetch for transcription uploads that uses undici with a restricted
 * TLS cipher list, so chatgpt.com's Cloudflare edge accepts the connection
 * from Electron as well as plain Node. Proxy environment variables are
 * honoured, with the same ciphers applied to the tunnelled origin connection.
 * undici loads on first use, so hosts that never transcribe do not load it.
 */
export function createCodexTranscriptionFetch(
  options: CreateCodexTranscriptionFetchOptions = {},
): CodexFetch {
  let dispatcher: Promise<{ undici: Undici; dispatcher: unknown }> | undefined;
  const load = () =>
    (dispatcher ??= import("undici").then((undici) => {
      const tls = {
        ciphers: options.ciphers ?? CODEX_TRANSCRIPTION_TLS_CIPHERS,
      };
      const base = { allowH2: true, connect: tls };
      return {
        undici,
        dispatcher: hasProxyEnv(options.env ?? process.env)
          ? // `requestTls` configures the tunnelled TLS session to the origin.
            new undici.EnvHttpProxyAgent({ ...base, requestTls: tls })
          : new undici.Agent(base),
      };
    }));
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const { undici, dispatcher } = await load();
    return (await undici.fetch(
      input as Parameters<Undici["fetch"]>[0],
      { ...init, dispatcher } as Parameters<Undici["fetch"]>[1],
    )) as unknown as Response;
  }) as CodexFetch;
}

let defaultTranscriptionFetch: CodexFetch | undefined;

/** Shared default used by `transcribeCodexAudio` when no `fetch` is given. */
export function getDefaultCodexTranscriptionFetch(): CodexFetch {
  defaultTranscriptionFetch ??= createCodexTranscriptionFetch();
  return defaultTranscriptionFetch;
}
