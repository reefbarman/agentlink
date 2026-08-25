import type {
  CoreModelCapabilities,
  CoreModelStreamRequest,
} from "../../../modelRuntime.js";

import type { CoreJsonValue } from "../../../webAccess.js";
import type { CoreReasoningEffort } from "../../../modelCatalog.js";

export type OpenAiCompatibleProfileKind = "generic" | "openrouter";

/** Model-vendor behavior used for prompt selection, independent of API transport. */
export type OpenAiCompatibleModelFamily = "anthropic" | "openai";

export type OpenAiCompatibleReasoningEffortMode =
  | "none"
  | "reasoning_effort"
  | "reasoning.effort"
  | "output_config.effort";

export interface OpenAiCompatibleRuntimeModel {
  /** Stable AgentLink model ID. */
  id: string;
  /** Opaque model ID sent to the upstream API. */
  model: string;
  /** Optional vendor-family behavior for prompts; never sent to the upstream API. */
  modelFamily?: OpenAiCompatibleModelFamily;
  capabilities: CoreModelCapabilities;
}

export interface OpenAiCompatibleRuntimeProfile {
  providerId: string;
  baseUrl: string;
  profile: OpenAiCompatibleProfileKind;
  reasoningEffortMode: OpenAiCompatibleReasoningEffortMode;
  headers?: Readonly<Record<string, string>>;
  timeoutMs: number;
  authRequired: boolean;
  models: Readonly<Record<string, OpenAiCompatibleRuntimeModel>>;
}

export type OpenAiCompatibleFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenAiCompatibleWireTextPart {
  type: "text";
  text: string;
}

export interface OpenAiCompatibleWireImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type OpenAiCompatibleWireContentPart =
  | OpenAiCompatibleWireTextPart
  | OpenAiCompatibleWireImagePart;

export interface OpenAiCompatibleWireToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type OpenAiCompatibleWireMessage =
  | { role: "system"; content: string }
  | {
      role: "user";
      content: string | OpenAiCompatibleWireContentPart[];
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAiCompatibleWireToolCall[];
      reasoning?: string;
      reasoning_content?: string;
      reasoning_details?: CoreJsonValue;
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

export interface OpenAiCompatibleWireTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAiCompatibleChatRequest {
  model: string;
  messages: OpenAiCompatibleWireMessage[];
  max_tokens: number;
  stream: true;
  tools?: OpenAiCompatibleWireTool[];
  tool_choice?: "auto";
  reasoning_effort?: CoreReasoningEffort;
  reasoning?: { effort: CoreReasoningEffort };
  output_config?: { effort: CoreReasoningEffort };
  parallel_tool_calls?: true;
  temperature?: number;
}

export interface OpenAiCompatibleSseFrame {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

export interface OpenAiCompatibleUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface OpenAiCompatibleDeltaToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAiCompatibleDelta {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoning_details?: CoreJsonValue;
  tool_calls?: OpenAiCompatibleDeltaToolCall[];
}

export interface OpenAiCompatibleChunkChoice {
  index?: number;
  delta?: OpenAiCompatibleDelta;
  finish_reason?: string | null;
}

export interface OpenAiCompatibleChatChunk {
  id?: string;
  model?: string;
  choices?: OpenAiCompatibleChunkChoice[];
  usage?: OpenAiCompatibleUsage | null;
  error?: unknown;
}

export interface OpenAiCompatibleStreamParserState {
  outputStarted: boolean;
}

export interface OpenAiCompatibleStreamOptions {
  providerId: string;
  estimatedInputTokens: number;
  sensitiveValues?: readonly string[];
  state?: OpenAiCompatibleStreamParserState;
  createThinkingId?: (choiceIndex: number) => string;
  maxReplayBytes?: number;
  /** Exact client-dispatched tool names exposed on this request. */
  availableToolNames?: readonly string[];
}

export interface OpenAiCompatibleFacadeRequest {
  profile: OpenAiCompatibleRuntimeProfile;
  apiKey?: string;
  request: CoreModelStreamRequest;
  temperature?: number;
  fetch?: OpenAiCompatibleFetch;
  maxRetries?: number;
  retryDelay?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}
