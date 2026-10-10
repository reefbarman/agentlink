import { getCodexOriginator, getCodexUserAgent } from "./clientIdentity.js";
import {
  CodexCredentialSession,
  type CodexCredentialProvider,
  type CodexResolvedAuth,
} from "./credentialResolution.js";
import type { CodexAuthMethod } from "./models.js";
import { OPENAI_API_BASE_URL, type CodexFetch } from "./openaiClient.js";

/**
 * ChatGPT/Codex subscription transcription endpoint used by Codex Desktop
 * dictation. It is undocumented, sits outside the `/backend-api/codex`
 * Responses base, and may change without notice.
 */
export const CODEX_TRANSCRIBE_URL =
  "https://chatgpt.com/backend-api/transcribe";

/** Public OpenAI Audio API model used when the credential is an API key. */
export const OPENAI_API_KEY_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

/** Credential `modelId` reported to hosts for transcription resolution. */
export const CODEX_TRANSCRIPTION_CREDENTIAL_MODEL_ID = "transcribe";

/** Matches the public Audio API upload ceiling. */
export const CODEX_TRANSCRIPTION_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export type CodexTranscriptionErrorCode =
  | "auth_required"
  | "audio_empty"
  | "audio_too_large"
  | "challenge_blocked"
  | "usage_limited"
  | "request_failed"
  | "invalid_response";

export class CodexTranscriptionError extends Error {
  override readonly name = "CodexTranscriptionError";

  constructor(
    readonly code: CodexTranscriptionErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface CodexTranscriptionAudio {
  /** Encoded audio bytes, for example WAV, WebM/Opus, MP4/AAC, or MP3. */
  readonly data: Uint8Array;
  /** MIME type of `data`, for example `audio/wav` or `audio/webm`. */
  readonly mimeType: string;
  /** Upload filename; the extension helps the backend detect the format. */
  readonly filename?: string;
}

export interface TranscribeCodexAudioOptions<TContext> {
  readonly credentialProvider: CodexCredentialProvider<TContext>;
  readonly context: TContext;
  readonly audio: CodexTranscriptionAudio;
  /** Optional ISO-639-1 language hint such as `en` or `ja`. */
  readonly language?: string;
  readonly signal?: AbortSignal;
  readonly fetch?: CodexFetch;
  readonly env?: NodeJS.ProcessEnv;
  /** Model for the API-key endpoint. Ignored for ChatGPT/Codex OAuth. */
  readonly apiKeyModel?: string;
}

export interface CodexTranscriptionResult {
  readonly text: string;
  readonly method: CodexAuthMethod;
}

/**
 * Transcribes one recorded audio clip with the host's Codex credential.
 * ChatGPT/Codex OAuth uses the subscription dictation endpoint; an OpenAI API
 * key uses the public Audio API. An expired OAuth token is refreshed once.
 */
export async function transcribeCodexAudio<TContext>(
  options: TranscribeCodexAudioOptions<TContext>,
): Promise<CodexTranscriptionResult> {
  const { audio } = options;
  if (audio.data.byteLength === 0) {
    throw new CodexTranscriptionError("audio_empty", "No audio was recorded.");
  }
  if (audio.data.byteLength > CODEX_TRANSCRIPTION_MAX_AUDIO_BYTES) {
    throw new CodexTranscriptionError(
      "audio_too_large",
      "The recording is too long to transcribe. Record a shorter clip.",
    );
  }

  let session: CodexCredentialSession<TContext>;
  try {
    session = await CodexCredentialSession.create({
      provider: options.credentialProvider,
      request: {
        context: options.context,
        modelId: CODEX_TRANSCRIPTION_CREDENTIAL_MODEL_ID,
        purpose: "transcription",
      },
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "auth_required") {
      throw new CodexTranscriptionError(
        "auth_required",
        "Sign in to ChatGPT/Codex to use voice input.",
      );
    }
    throw error;
  }

  let response = await sendTranscriptionRequest(session.auth, options);
  if (response.status === 401 && (await session.refreshOAuth())) {
    response = await sendTranscriptionRequest(session.auth, options);
  }
  return {
    text: await readTranscriptionResponse(response),
    method: session.auth.method,
  };
}

async function sendTranscriptionRequest<TContext>(
  auth: CodexResolvedAuth,
  options: TranscribeCodexAudioOptions<TContext>,
): Promise<Response> {
  const env = options.env ?? process.env;
  const fields: Array<[string, string]> = [];
  const language = options.language?.trim();
  if (language) fields.push(["language", language]);

  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${auth.bearerToken}`,
    "User-Agent": getCodexUserAgent(env),
  };
  let url: string;
  if (auth.method === "oauth") {
    url = CODEX_TRANSCRIBE_URL;
    headers.originator = getCodexOriginator(env);
    if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  } else {
    url = `${OPENAI_API_BASE_URL}/audio/transcriptions`;
    fields.push([
      "model",
      options.apiKeyModel ?? OPENAI_API_KEY_TRANSCRIPTION_MODEL,
    ]);
    fields.push(["response_format", "json"]);
  }

  const multipart = encodeMultipart(fields, {
    name: "file",
    filename: options.audio.filename ?? defaultFilename(options.audio.mimeType),
    mimeType: options.audio.mimeType,
    data: options.audio.data,
  });
  headers["Content-Type"] = multipart.contentType;

  return await (options.fetch ?? globalThis.fetch)(url, {
    method: "POST",
    headers,
    body: multipart.body,
    signal: options.signal,
  });
}

/**
 * Encodes a multipart/form-data body as bytes. Hosts may supply a fetch from
 * a different realm or library (for example a bundled undici) that does not
 * serialize the runtime's global FormData/Blob, so the body is built here.
 */
function encodeMultipart(
  fields: ReadonlyArray<readonly [string, string]>,
  file: {
    name: string;
    filename: string;
    mimeType: string;
    data: Uint8Array;
  },
): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const boundary = `----agentlink${Array.from(
    globalThis.crypto.getRandomValues(new Uint8Array(12)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")}`;
  const encoder = new TextEncoder();
  const quote = (value: string) => value.replace(/["\r\n\\]/gu, "_");
  const parts: Uint8Array[] = [];
  for (const [name, value] of fields) {
    parts.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${quote(file.name)}"; filename="${quote(file.filename)}"\r\nContent-Type: ${file.mimeType.replace(/[\r\n]/gu, "")}\r\n\r\n`,
    ),
    file.data,
    encoder.encode(`\r\n--${boundary}--\r\n`),
  );
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const body = new Uint8Array(new ArrayBuffer(length));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function readTranscriptionResponse(response: Response): Promise<string> {
  const body = await response.text();
  if (!response.ok) {
    throw classifyFailure(response, body);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new CodexTranscriptionError(
      "invalid_response",
      "The transcription service returned an unreadable response.",
      response.status,
    );
  }
  const text =
    payload && typeof payload === "object"
      ? (payload as { text?: unknown }).text
      : undefined;
  if (typeof text !== "string") {
    throw new CodexTranscriptionError(
      "invalid_response",
      "The transcription service response did not include text.",
      response.status,
    );
  }
  return text.trim();
}

function classifyFailure(
  response: Response,
  body: string,
): CodexTranscriptionError {
  const status = response.status;
  if (
    status === 403 &&
    response.headers.get("cf-mitigated")?.toLowerCase() === "challenge"
  ) {
    return new CodexTranscriptionError(
      "challenge_blocked",
      "ChatGPT's network protection blocked the transcription request. Try again later.",
      status,
    );
  }
  if (status === 401 || status === 403) {
    return new CodexTranscriptionError(
      "auth_required",
      "Your ChatGPT/Codex sign-in was rejected. Sign in again to use voice input.",
      status,
    );
  }
  if (status === 429) {
    return new CodexTranscriptionError(
      "usage_limited",
      "Transcription is rate limited right now. Try again shortly.",
      status,
    );
  }
  if (status === 413) {
    return new CodexTranscriptionError(
      "audio_too_large",
      "The recording is too long to transcribe. Record a shorter clip.",
      status,
    );
  }
  return new CodexTranscriptionError(
    "request_failed",
    `Transcription failed (HTTP ${status})${summarizeBody(body)}.`,
    status,
  );
}

function summarizeBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed || trimmed.startsWith("<")) return "";
  try {
    const parsed = JSON.parse(trimmed) as {
      detail?: unknown;
      error?: { message?: unknown } | unknown;
    };
    const message =
      typeof parsed.detail === "string"
        ? parsed.detail
        : parsed.error &&
            typeof parsed.error === "object" &&
            typeof (parsed.error as { message?: unknown }).message === "string"
          ? (parsed.error as { message: string }).message
          : undefined;
    if (message) return `: ${message.slice(0, 200)}`;
  } catch {
    // Non-JSON bodies are summarized below.
  }
  return `: ${trimmed.slice(0, 200)}`;
}

function defaultFilename(mimeType: string): string {
  const subtype = mimeType.split(";")[0]?.split("/")[1]?.trim().toLowerCase();
  switch (subtype) {
    case "wav":
    case "x-wav":
    case "wave":
      return "audio.wav";
    case "webm":
      return "audio.webm";
    case "ogg":
      return "audio.ogg";
    case "mp4":
    case "m4a":
    case "x-m4a":
    case "aac":
      return "audio.m4a";
    case "mpeg":
    case "mp3":
      return "audio.mp3";
    default:
      return "audio.wav";
  }
}
