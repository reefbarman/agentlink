import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type {
  CoreModelBackend,
  CoreModelContentBlock,
  CoreModelMessage,
  CoreModelStopReason,
  CoreModelStreamEvent,
  CoreModelStreamRequest,
  CoreModelToolDefinition,
} from "@agentlink/core";
import { isCoreReasoningEffort } from "@agentlink/protocol/model-catalog";
import { isPromptProfile } from "@agentlink/protocol/prompt-profile";

/**
 * Models for the AgentLink extension inside a task's editor. The editor has
 * no sign-in or key: AgentLink there is set up with an OpenAI-compatible
 * connection to this endpoint, which makes the calls with the assistant's
 * own model backends (like session runners' model proxy).
 *
 * - `POST /editor-models/<token>/v1/chat/completions` (streamed or not) and
 *   `GET /editor-models/<token>/v1/models`. The token is per editor, valid
 *   only while that editor runs, and sits in the path because AgentLink
 *   refuses credential headers in its settings.
 * - Wire model IDs are `<providerId>/<modelId>` of the assistant's models.
 * - Thinking is not passed back (Chat Completions cannot carry its
 *   signatures), and reasoning in the history is dropped.
 */

const PATH =
  /^\/editor-models\/([A-Za-z0-9_-]{16,128})\/v1\/(chat\/completions|models)$/u;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_MODELS = 100;

export interface EditorModelChoice {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName?: string;
}

export interface EditorModelServer {
  readonly port: number;
  close(): Promise<void>;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The AgentLink model ID an editor shows for an assistant model. */
export function editorModelId(choice: EditorModelChoice): string {
  return `assistant-${choice.providerId}-${choice.modelId}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-");
}

/**
 * The editor's AgentLink settings: one connection to this endpoint with the
 * assistant's models, the first as the default, and Codex sign-in hidden.
 */
export function editorAgentLinkSettings(options: {
  readonly baseUrl: string;
  readonly backends: readonly CoreModelBackend[];
  readonly models: readonly EditorModelChoice[];
  readonly noProxy: readonly string[];
}): Record<string, unknown> {
  const byId = new Map(options.backends.map((b) => [b.providerId, b]));
  const models: Record<string, unknown>[] = [];
  for (const choice of options.models) {
    if (models.length >= MAX_MODELS) break;
    const backend = byId.get(choice.providerId);
    if (!backend) continue;
    let capabilities;
    try {
      capabilities = backend.getCapabilities(choice.modelId);
    } catch {
      continue;
    }
    const efforts = (capabilities.reasoningEfforts ?? []).filter(
      (effort) => effort !== "none",
    );
    const profile = backend.getPromptProfile?.(choice.modelId);
    models.push({
      id: editorModelId(choice),
      model: `${choice.providerId}/${choice.modelId}`,
      displayName: choice.displayName ?? choice.modelId,
      contextWindow: capabilities.contextWindow,
      ...(capabilities.maxInputTokens
        ? { maxInputTokens: capabilities.maxInputTokens }
        : {}),
      maxOutputTokens: capabilities.maxOutputTokens,
      supportsToolUse: true,
      ...(capabilities.supportsImages ? { supportsImages: true } : {}),
      ...(efforts.length > 0
        ? {
            supportsThinking: true,
            reasoningEfforts: efforts,
            defaultReasoningEffort:
              capabilities.defaultReasoningEffort &&
              (efforts as readonly string[]).includes(
                capabilities.defaultReasoningEffort,
              )
                ? capabilities.defaultReasoningEffort
                : efforts[0],
          }
        : {}),
      ...(profile && isPromptProfile(profile)
        ? { promptProfile: profile }
        : {}),
    });
  }
  const preferred = models[0]?.id;
  return {
    "agentlink.openaiCompatible.connections": [
      {
        id: "assistant",
        displayName: "AgentLink Assistant",
        baseUrl: options.baseUrl,
        profile: "generic",
        reasoningEffortMode: "reasoning_effort",
        timeoutMs: 600_000,
        models,
      },
    ],
    "agentlink.disabledProviders": ["codex"],
    ...(preferred
      ? {
          "agentlink.modeModelPreferences": {
            code: preferred,
            architect: preferred,
            ask: preferred,
            debug: preferred,
          },
        }
      : {}),
    "http.noProxy": [...options.noProxy],
    "telemetry.telemetryLevel": "off",
  };
}

/** Chat Completions messages as the assistant's model request. */
export function chatMessagesToCore(raw: unknown): {
  readonly systemPrompt: string;
  readonly messages: CoreModelMessage[];
} {
  if (!Array.isArray(raw)) {
    throw new RequestError(
      400,
      "messages_invalid",
      "messages must be an array",
    );
  }
  const system: string[] = [];
  const messages: CoreModelMessage[] = [];
  const push = (
    role: "user" | "assistant",
    blocks: CoreModelContentBlock[],
  ) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    // Tool results and the user's text after them are one user message.
    if (last && last.role === role && Array.isArray(last.content)) {
      last.content.push(...blocks);
      return;
    }
    messages.push({ role, content: blocks });
  };
  for (const entry of raw) {
    const message = record(entry);
    if (!message) {
      throw new RequestError(400, "messages_invalid", "invalid message");
    }
    const role = message.role;
    if (role === "system" || role === "developer") {
      const text = textOf(message.content);
      if (text) system.push(text);
    } else if (role === "user") {
      push("user", userBlocks(message.content));
    } else if (role === "assistant") {
      const blocks: CoreModelContentBlock[] = [];
      const text = textOf(message.content);
      if (text) blocks.push({ type: "text", text });
      for (const call of Array.isArray(message.tool_calls)
        ? message.tool_calls
        : []) {
        const fn = record(record(call)?.function);
        const id = record(call)?.id;
        if (typeof id !== "string" || typeof fn?.name !== "string") {
          throw new RequestError(400, "messages_invalid", "invalid tool call");
        }
        blocks.push({
          type: "tool_use",
          id,
          name: fn.name,
          input: parseArguments(fn.arguments),
        });
      }
      push("assistant", blocks);
    } else if (role === "tool") {
      if (typeof message.tool_call_id !== "string") {
        throw new RequestError(400, "messages_invalid", "tool_call_id missing");
      }
      push("user", [
        {
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: textOf(message.content),
        },
      ]);
    } else {
      throw new RequestError(400, "messages_invalid", "unknown message role");
    }
  }
  return { systemPrompt: system.join("\n\n"), messages };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const item = record(part);
      return item?.type === "text" && typeof item.text === "string"
        ? item.text
        : "";
    })
    .join("");
}

function userBlocks(content: unknown): CoreModelContentBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: CoreModelContentBlock[] = [];
  for (const part of content) {
    const item = record(part);
    if (item?.type === "text" && typeof item.text === "string") {
      blocks.push({ type: "text", text: item.text });
    } else if (item?.type === "image_url") {
      const url = record(item.image_url)?.url;
      const match =
        typeof url === "string"
          ? /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/u.exec(url)
          : null;
      if (!match) {
        throw new RequestError(400, "image_invalid", "only data: images");
      }
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: match[1] as "image/png",
          data: match[2]!,
        },
      });
    }
  }
  return blocks;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    return record(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function tools(raw: unknown): CoreModelToolDefinition[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((entry) => {
    const fn = record(record(entry)?.function);
    if (typeof fn?.name !== "string") {
      throw new RequestError(400, "tools_invalid", "invalid tool");
    }
    return {
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      input_schema: (record(fn.parameters) as
        | CoreModelToolDefinition["input_schema"]
        | undefined) ?? { type: "object", properties: {} },
    };
  });
}

/** A Chat Completions request as a stream request for one backend. */
export function chatRequestToCore(
  body: unknown,
  backends: ReadonlyMap<string, CoreModelBackend>,
  signal: AbortSignal,
): {
  readonly backend: CoreModelBackend;
  readonly request: CoreModelStreamRequest;
} {
  const value = record(body);
  if (!value) throw new RequestError(400, "body_invalid");
  const model = typeof value.model === "string" ? value.model : "";
  const slash = model.indexOf("/");
  const backend = slash > 0 ? backends.get(model.slice(0, slash)) : undefined;
  const modelId = model.slice(slash + 1);
  if (!backend || !modelId) {
    throw new RequestError(404, "model_not_found", `unknown model ${model}`);
  }
  let capabilities;
  try {
    capabilities = backend.getCapabilities(modelId);
  } catch {
    throw new RequestError(404, "model_not_found", `unknown model ${model}`);
  }
  const { systemPrompt, messages } = chatMessagesToCore(value.messages);
  const maxTokens =
    typeof value.max_tokens === "number" && value.max_tokens > 0
      ? Math.min(Math.floor(value.max_tokens), capabilities.maxOutputTokens)
      : capabilities.maxOutputTokens;
  const effort = value.reasoning_effort;
  const format = record(record(value.response_format)?.json_schema);
  const toolList = tools(value.tools);
  return {
    backend,
    request: {
      model: modelId,
      systemPrompt,
      messages,
      maxTokens,
      ...(isCoreReasoningEffort(effort) &&
      capabilities.reasoningEfforts?.includes(effort)
        ? { reasoningEffort: effort }
        : {}),
      ...(toolList ? { tools: toolList } : {}),
      ...(format && typeof format.name === "string" && record(format.schema)
        ? {
            outputFormat: {
              type: "json_schema" as const,
              name: format.name,
              schema: format.schema as CoreModelToolDefinition["input_schema"],
              ...(typeof format.strict === "boolean"
                ? { strict: format.strict }
                : {}),
            },
          }
        : {}),
      ...(typeof value.temperature === "number" &&
      capabilities.supportsTemperature
        ? { temperature: value.temperature }
        : {}),
      signal,
    },
  };
}

const FINISH: Record<CoreModelStopReason, string> = {
  end_turn: "stop",
  pause_turn: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  refusal: "content_filter",
};

/**
 * The backend's events as Chat Completions chunks. Tool arguments are sent
 * whole when the call is done (the backend's final input), not as deltas.
 */
export async function* coreEventsToChatChunks(
  events: AsyncIterable<CoreModelStreamEvent>,
  meta: {
    readonly id: string;
    readonly model: string;
    readonly created: number;
  },
): AsyncGenerator<Record<string, unknown>> {
  const chunk = (
    delta: Record<string, unknown>,
    finish: string | null = null,
  ) => ({
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const toolIndex = new Map<string, number>();
  let sawToolCall = false;
  let sent = false;
  let finish: string | undefined;
  let usage: Record<string, number> | undefined;
  yield chunk({ role: "assistant", content: "" });
  for await (const event of events) {
    switch (event.type) {
      case "response_retry":
        // The backend starts the response again; nothing sent can be
        // taken back, so a retry after output is a failure.
        if (sent) {
          throw new Error("the model response was retried mid-stream");
        }
        break;
      case "text_delta":
        if (event.text) {
          sent = true;
          yield chunk({ content: event.text });
        }
        break;
      case "tool_start": {
        sent = true;
        const index = toolIndex.size;
        toolIndex.set(event.toolCallId, index);
        sawToolCall = true;
        yield chunk({
          tool_calls: [
            {
              index,
              id: event.toolCallId,
              type: "function",
              function: { name: event.toolName, arguments: "" },
            },
          ],
        });
        break;
      }
      case "tool_done": {
        sent = true;
        let index = toolIndex.get(event.toolCallId);
        if (index === undefined) {
          index = toolIndex.size;
          toolIndex.set(event.toolCallId, index);
          sawToolCall = true;
          yield chunk({
            tool_calls: [
              {
                index,
                id: event.toolCallId,
                type: "function",
                function: { name: event.toolName, arguments: "" },
              },
            ],
          });
        }
        yield chunk({
          tool_calls: [
            {
              index,
              function: { arguments: JSON.stringify(event.input ?? {}) },
            },
          ],
        });
        break;
      }
      case "model_stop":
        finish = FINISH[event.reason];
        break;
      case "usage":
        usage = {
          prompt_tokens:
            event.inputTokens +
            (event.cacheReadTokens ?? 0) +
            (event.cacheCreationTokens ?? 0),
          completion_tokens: event.outputTokens,
          total_tokens:
            event.inputTokens +
            (event.cacheReadTokens ?? 0) +
            (event.cacheCreationTokens ?? 0) +
            event.outputTokens,
        };
        break;
      default:
        // Thinking, hosted web activity and transport notices stay here.
        break;
    }
  }
  yield chunk({}, finish ?? (sawToolCall ? "tool_calls" : "stop"));
  if (usage) {
    yield {
      id: meta.id,
      object: "chat.completion.chunk",
      created: meta.created,
      model: meta.model,
      choices: [],
      usage,
    };
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new RequestError(413, "body_too_large");
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "body_invalid", "the body is not JSON");
  }
}

function errorBody(error: unknown) {
  const code =
    error instanceof RequestError
      ? error.code
      : typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : "model_request_failed";
  const message = (
    error instanceof Error ? error.message : String(error)
  ).slice(0, 500);
  return { error: { message, type: code, code } };
}

/**
 * The endpoint. `authorize` turns a token into the editor's task, or
 * nothing once that editor has stopped.
 */
export async function startEditorModelServer(options: {
  readonly backends: readonly CoreModelBackend[];
  readonly models: () => readonly EditorModelChoice[];
  readonly authorize: (token: string) => string | undefined;
  readonly listen: { readonly host: string; readonly port: number };
  readonly log: (line: string) => void;
  readonly now?: () => number;
}): Promise<EditorModelServer> {
  const backends = new Map(options.backends.map((b) => [b.providerId, b]));
  const now = options.now ?? Date.now;
  let sequence = 0;

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://editor-models.invalid");
    const match = PATH.exec(url.pathname);
    if (!match) throw new RequestError(404, "not_found");
    const taskId = options.authorize(match[1]!);
    if (!taskId) {
      throw new RequestError(401, "editor_closed", "this editor has closed");
    }
    if (match[2] === "models") {
      if (request.method !== "GET") {
        throw new RequestError(405, "method_not_allowed");
      }
      send(response, 200, {
        object: "list",
        data: options.models().map((model) => ({
          id: `${model.providerId}/${model.modelId}`,
          object: "model",
          owned_by: model.providerId,
        })),
      });
      return;
    }
    if (request.method !== "POST") {
      throw new RequestError(405, "method_not_allowed");
    }
    const body = await readBody(request);
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    const { backend, request: core } = chatRequestToCore(
      body,
      backends,
      abort.signal,
    );
    const context = {
      principal: { tenantId: "local", subjectId: `editor-task-${taskId}` },
      authContext: undefined,
    };
    sequence += 1;
    const meta = {
      id: `chatcmpl-editor-${now().toString(36)}-${sequence}`,
      model: (body as { model: string }).model,
      created: Math.floor(now() / 1000),
    };
    const chunks = coreEventsToChatChunks(backend.stream(core, context), meta);
    if ((body as { stream?: unknown }).stream !== true) {
      let text = "";
      let finish = "stop";
      let usage: unknown;
      const calls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }> = [];
      for await (const item of chunks) {
        if (item.usage) usage = item.usage;
        const choice = (item.choices as Array<Record<string, unknown>>)[0];
        if (!choice) continue;
        const delta = choice.delta as Record<string, unknown>;
        if (typeof delta.content === "string") text += delta.content;
        for (const call of (delta.tool_calls ?? []) as Array<{
          index: number;
          id?: string;
          function: { name?: string; arguments: string };
        }>) {
          const existing = calls[call.index];
          if (existing) existing.function.arguments += call.function.arguments;
          else {
            calls[call.index] = {
              id: call.id ?? "",
              type: "function",
              function: {
                name: call.function.name ?? "",
                arguments: call.function.arguments,
              },
            };
          }
        }
        if (typeof choice.finish_reason === "string") {
          finish = choice.finish_reason;
        }
      }
      send(response, 200, {
        id: meta.id,
        object: "chat.completion",
        created: meta.created,
        model: meta.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: text || null,
              ...(calls.length > 0 ? { tool_calls: calls } : {}),
            },
            finish_reason: finish,
          },
        ],
        ...(usage ? { usage } : {}),
      });
      return;
    }
    // The first event decides between an HTTP error and a stream.
    const first = await chunks.next();
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const write = (data: unknown) =>
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    try {
      if (!first.done) write(first.value);
      for await (const item of chunks) write(item);
      response.end("data: [DONE]\n\n");
    } catch (error) {
      if (!abort.signal.aborted) {
        options.log(
          `Editor model call for task ${taskId} failed: ${errorBody(error).error.message}`,
        );
        write(errorBody(error));
      }
      response.end();
    }
  };

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const status = error instanceof RequestError ? error.status : 502;
      if (!(error instanceof RequestError)) {
        options.log(
          `Editor model call failed: ${errorBody(error).error.message}`,
        );
      }
      if (response.headersSent) {
        response.end();
        return;
      }
      send(response, status, errorBody(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.listen.port, options.listen.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  options.log(`Editor models on ${options.listen.host}:${port}`);
  return {
    port,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}
