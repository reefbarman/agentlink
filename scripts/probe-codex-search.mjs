#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const DEFAULT_MODEL = "gpt-5.6";
const DEFAULT_URL = "https://example.com/";

function usage() {
  console.log(`
Codex standalone search endpoint probe

Calls the endpoint used by Codex's standalone web.run implementation. The OAuth
token is read in-process and is never printed.

Usage:
  node scripts/probe-codex-search.mjs [options]

Options:
  --url <url>                   Open an exact URL (default: ${DEFAULT_URL})
  --query <query>               Run a search instead of opening a URL
  --find <pattern>              Find text in the URL supplied with --url
  --mode <cached|indexed|live>  External web access mode (default: cached)
  --model <model>               Model sent to the search endpoint (default: ${DEFAULT_MODEL})
  --response-length <length>    short, medium, or long (default: short)
  --timeout-ms <milliseconds>   Request timeout (default: 30000)
  --auth-json <path>            Codex auth.json path
  --base-url <url>              Override the Codex backend base URL
  --help                        Show this help

Environment overrides:
  CODEX_AUTH_JSON
  CODEX_SEARCH_PROBE_BASE_URL
  CODEX_SEARCH_PROBE_MODEL
`);
}

function parseArgs(argv) {
  const options = {
    authPath: process.env.CODEX_AUTH_JSON ?? DEFAULT_AUTH_PATH,
    baseUrl: process.env.CODEX_SEARCH_PROBE_BASE_URL ?? DEFAULT_BASE_URL,
    find: undefined,
    help: false,
    mode: "cached",
    model: process.env.CODEX_SEARCH_PROBE_MODEL ?? DEFAULT_MODEL,
    query: undefined,
    responseLength: "short",
    timeoutMs: 30_000,
    url: DEFAULT_URL,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (
      arg === "--url" ||
      arg === "--query" ||
      arg === "--find" ||
      arg === "--mode" ||
      arg === "--model" ||
      arg === "--response-length" ||
      arg === "--timeout-ms" ||
      arg === "--auth-json" ||
      arg === "--base-url"
    ) {
      if (!next) throw new Error(`Missing value for ${arg}`);
      index += 1;
      if (arg === "--url") options.url = next;
      if (arg === "--query") options.query = next;
      if (arg === "--find") options.find = next;
      if (arg === "--mode") options.mode = next;
      if (arg === "--model") options.model = next;
      if (arg === "--response-length") options.responseLength = next;
      if (arg === "--timeout-ms") options.timeoutMs = Number(next);
      if (arg === "--auth-json") options.authPath = next;
      if (arg === "--base-url") options.baseUrl = next;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!new Set(["cached", "indexed", "live"]).has(options.mode)) {
    throw new Error(`Invalid --mode value: ${options.mode}`);
  }
  if (!new Set(["short", "medium", "long"]).has(options.responseLength)) {
    throw new Error(
      `Invalid --response-length value: ${options.responseLength}`,
    );
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error(`Invalid --timeout-ms value: ${options.timeoutMs}`);
  }
  if (options.query && options.find) {
    throw new Error("--query and --find cannot be used together");
  }
  if (!options.query) {
    const url = new URL(options.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("--url must use HTTP or HTTPS");
    }
    options.url = url.toString();
  }

  options.authPath = path.resolve(options.authPath);
  options.baseUrl = options.baseUrl.replace(/\/+$/, "");
  return options;
}

async function readAuth(authPath) {
  const data = JSON.parse(await fs.readFile(authPath, "utf8"));
  const tokens = data.tokens ?? data;
  const accessToken =
    tokens.access_token ?? data.access_token ?? data.OPENAI_API_KEY;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    throw new Error(`No access token found in ${authPath}`);
  }

  const idToken = tokens.id_token;
  const accountId =
    tokens.account_id ??
    data.account_id ??
    data.accountId ??
    (idToken && typeof idToken === "object"
      ? idToken.chatgpt_account_id
      : undefined);
  return {
    accessToken: accessToken.trim(),
    accountId:
      typeof accountId === "string" && accountId.trim()
        ? accountId.trim()
        : undefined,
  };
}

function externalWebAccess(mode) {
  if (mode === "cached") return false;
  if (mode === "indexed") return "indexed";
  return true;
}

function commands(options) {
  if (options.query) {
    return {
      search_query: [{ q: options.query }],
      response_length: options.responseLength,
    };
  }
  if (options.find) {
    return {
      find: [{ ref_id: options.url, pattern: options.find }],
      response_length: options.responseLength,
    };
  }
  return {
    open: [{ ref_id: options.url }],
    response_length: options.responseLength,
  };
}

function requestInput(options) {
  const text = options.query
    ? `Search the web for: ${options.query}`
    : options.find
      ? `Find ${JSON.stringify(options.find)} in ${options.url}`
      : `Open and read ${options.url}`;
  return [
    {
      role: "user",
      content: [{ type: "input_text", text }],
    },
  ];
}

function summarizeResults(results) {
  if (!Array.isArray(results)) return undefined;
  return results.slice(0, 10).map((result) => {
    if (!result || typeof result !== "object") {
      return { type: typeof result };
    }
    return {
      type: typeof result.type === "string" ? result.type : undefined,
      refId: typeof result.ref_id === "string" ? result.ref_id : undefined,
      url: typeof result.url === "string" ? result.url : undefined,
      title: typeof result.title === "string" ? result.title : undefined,
      keys: Object.keys(result).sort(),
    };
  });
}

function summarizeErrorBody(text) {
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error ?? parsed;
    return {
      code: typeof error?.code === "string" ? error.code : undefined,
      message:
        typeof error?.message === "string"
          ? error.message.slice(0, 500)
          : undefined,
      type: typeof error?.type === "string" ? error.type : undefined,
      keys: error && typeof error === "object" ? Object.keys(error).sort() : [],
    };
  } catch {
    return { preview: text.slice(0, 500) };
  }
}

async function probe(options) {
  const auth = await readAuth(options.authPath);
  const sessionId = crypto.randomUUID();
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${auth.accessToken}`,
    "content-type": "application/json",
    originator: "agentlink",
    session_id: sessionId,
    "user-agent": `agentlink-search-probe (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

  const body = {
    id: sessionId,
    model: options.model,
    input: requestInput(options),
    commands: commands(options),
    settings: {
      allowed_callers: ["direct"],
      external_web_access: externalWebAccess(options.mode),
    },
    max_output_tokens: 4_096,
  };

  const startedAt = performance.now();
  const response = await fetch(`${options.baseUrl}/alpha/search`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const durationMs = Math.round(performance.now() - startedAt);
  const responseText = await response.text();
  const common = {
    ok: response.ok,
    status: response.status,
    durationMs,
    contentType: response.headers.get("content-type"),
    requestId:
      response.headers.get("x-request-id") ??
      response.headers.get("x-openai-request-id"),
  };

  if (!response.ok) {
    return { ...common, error: summarizeErrorBody(responseText) };
  }

  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    return {
      ...common,
      response: { json: false, preview: responseText.slice(0, 500) },
    };
  }

  return {
    ...common,
    response: {
      json: true,
      keys: Object.keys(payload).sort(),
      encryptedOutputPresent:
        typeof payload.encrypted_output === "string" &&
        payload.encrypted_output.length > 0,
      outputLength:
        typeof payload.output === "string" ? payload.output.length : undefined,
      outputPreview:
        typeof payload.output === "string"
          ? payload.output.slice(0, 500)
          : undefined,
      resultCount: Array.isArray(payload.results)
        ? payload.results.length
        : undefined,
      results: summarizeResults(payload.results),
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  console.error(
    JSON.stringify(
      {
        endpoint: `${options.baseUrl}/alpha/search`,
        authPath: options.authPath,
        model: options.model,
        mode: options.mode,
        operation: options.query ? "search" : options.find ? "find" : "open",
      },
      null,
      2,
    ),
  );
  const result = await probe(options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exitCode = 1;
});
