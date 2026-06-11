#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const OAUTH_REFRESH_URL = "https://auth.openai.com/oauth/token";
const AUTH_PATH =
  process.env.CODEX_AUTH_JSON ?? path.join(os.homedir(), ".codex", "auth.json");
const OUT_DIR = path.resolve(process.cwd(), "tmp", "codex-image-probe");
const MODEL = process.env.CODEX_IMAGE_PROBE_MODEL ?? "gpt-5.5";
const rawArgs = process.argv.slice(2);
const refFlagIndex = rawArgs.findIndex((arg) => arg === "--ref");
const REF_IMAGE =
  refFlagIndex >= 0 && rawArgs[refFlagIndex + 1]
    ? path.resolve(process.cwd(), rawArgs[refFlagIndex + 1])
    : undefined;
if (refFlagIndex >= 0) {
  rawArgs.splice(refFlagIndex, 2);
}
const PROMPT =
  rawArgs.join(" ") ||
  "Generate one tiny simple blue circle icon on a white background.";

function redact(value) {
  if (!value) return undefined;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

async function readAuth() {
  const raw = await fs.readFile(AUTH_PATH, "utf8");
  const data = JSON.parse(raw);
  const tokens = data.tokens ?? data;
  const accessToken =
    tokens.access_token ?? data.access_token ?? data.OPENAI_API_KEY;
  const refreshToken = tokens.refresh_token ?? data.refresh_token;
  const accountId = tokens.account_id ?? data.account_id ?? data.accountId;
  return { data, tokens, accessToken, refreshToken, accountId };
}

async function refreshAuth(auth) {
  if (!auth.refreshToken) return auth;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken,
    client_id: "codex_cli_rs",
  });
  const res = await fetch(OAUTH_REFRESH_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`refresh failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const refreshed = await res.json();
  const next = structuredClone(auth.data);
  if (next.tokens) {
    next.tokens.access_token = refreshed.access_token;
    if (refreshed.refresh_token)
      next.tokens.refresh_token = refreshed.refresh_token;
    if (refreshed.expires_in)
      next.tokens.expires_at = Date.now() + refreshed.expires_in * 1000;
  }
  await fs.writeFile(AUTH_PATH, JSON.stringify(next, null, 2));
  return readAuth();
}

function headers(auth, sessionId) {
  const out = {
    authorization: `Bearer ${auth.accessToken}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    originator: "agentlink-probe",
    session_id: sessionId,
    "user-agent": `agentlink-image-probe (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
  };
  if (auth.accountId) out["ChatGPT-Account-Id"] = auth.accountId;
  return out;
}

async function imageContentBlocks() {
  const content = [
    {
      type: "input_text",
      text: `Use image generation. ${PROMPT}`,
    },
  ];
  if (REF_IMAGE) {
    const ext = path.extname(REF_IMAGE).toLowerCase();
    const mimeType =
      ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".webp"
          ? "image/webp"
          : ext === ".gif"
            ? "image/gif"
            : "image/png";
    const data = await fs.readFile(REF_IMAGE);
    content.push({
      type: "input_image",
      image_url: `data:${mimeType};base64,${data.toString("base64")}`,
      detail: "high",
    });
  }
  return content;
}

async function requestBody({ includeToolChoice }) {
  const body = {
    model: MODEL,
    stream: true,
    store: false,
    instructions:
      "You are an image generation helper. Use the image_generation tool to create exactly one PNG image. Do not add commentary.",
    input: [
      {
        role: "user",
        content: await imageContentBlocks(),
      },
    ],
    tools: [{ type: "image_generation" }],
  };
  if (includeToolChoice) body.tool_choice = { type: "image_generation" };
  return body;
}

async function parseSse(res) {
  const decoder = new TextDecoder();
  let buf = "";
  const eventCounts = new Map();
  const samples = [];
  const saved = [];
  await fs.mkdir(OUT_DIR, { recursive: true });

  async function handleDataLine(line) {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") return;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      samples.push({ parse_error: data.slice(0, 500) });
      return;
    }
    const type = json.type ?? "<missing-type>";
    eventCounts.set(type, (eventCounts.get(type) ?? 0) + 1);
    if (samples.length < 20) {
      samples.push({
        type,
        keys: Object.keys(json),
        output_index: json.output_index,
        item_id: json.item_id,
        partial_image_index: json.partial_image_index,
        item_type: json.item?.type,
        status: json.item?.status,
        size: json.size,
        quality: json.quality,
        background: json.background,
        output_format: json.output_format,
        has_partial_image_b64: typeof json.partial_image_b64 === "string",
        partial_image_b64_length:
          typeof json.partial_image_b64 === "string"
            ? json.partial_image_b64.length
            : undefined,
        has_b64_json: typeof json.b64_json === "string",
        has_result: typeof json.result === "string",
        has_image: typeof json.image === "string",
        text:
          typeof json.text === "string" ? json.text.slice(0, 200) : undefined,
      });
    }

    const b64 =
      (typeof json.partial_image_b64 === "string" && json.partial_image_b64) ||
      (typeof json.b64_json === "string" && json.b64_json) ||
      (typeof json.result === "string" && json.result) ||
      (typeof json.image === "string" && json.image);
    if (b64 && b64.length > 1000) {
      const file = path.join(
        OUT_DIR,
        `probe-${saved.length + 1}-${type.replace(/[^a-z0-9_-]+/gi, "_")}.png`,
      );
      await fs.writeFile(file, Buffer.from(b64, "base64"));
      saved.push({ file, type, bytes: Buffer.byteLength(b64, "base64") });
    }
  }

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      await handleDataLine(line);
    }
  }
  if (buf.trim()) await handleDataLine(buf.trim());
  return { eventCounts: Object.fromEntries(eventCounts), samples, saved };
}

async function attempt(auth, includeToolChoice) {
  const sessionId = crypto.randomUUID();
  const res = await fetch(`${CODEX_BASE_URL}/responses`, {
    method: "POST",
    headers: headers(auth, sessionId),
    body: JSON.stringify(await requestBody({ includeToolChoice })),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      body: text.slice(0, 1000),
      includeToolChoice,
    };
  }
  const parsed = await parseSse(res);
  return { ok: true, status: res.status, includeToolChoice, ...parsed };
}

async function main() {
  let auth = await readAuth();
  console.error(
    JSON.stringify(
      {
        authPath: AUTH_PATH,
        accountId: redact(auth.accountId),
        accessToken: redact(auth.accessToken),
        model: MODEL,
        refImage: REF_IMAGE,
      },
      null,
      2,
    ),
  );

  let first = await attempt(auth, true);
  if (!first.ok && first.status === 401) {
    console.error("401; refreshing OAuth token and retrying");
    auth = await refreshAuth(auth);
    first = await attempt(auth, true);
  }
  console.log(JSON.stringify({ prompt: PROMPT, result: first }, null, 2));

  if (!first.ok && first.status === 400) {
    console.error("tool_choice attempt rejected; retrying without tool_choice");
    const second = await attempt(auth, false);
    console.log(JSON.stringify({ prompt: PROMPT, result: second }, null, 2));
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
