import {
  useReducer,
  useEffect,
  useCallback,
  useRef,
  useState,
} from "preact/hooks";
import type {
  ExtensionMessage,
  ChatMessage,
  ChatState,
  ContentBlock,
  TodoItem,
  ModeInfo,
  SlashCommandInfo,
  Question,
  SessionSummary,
} from "./types";
import type {
  ApprovalRequest,
  DecisionMessage,
} from "../../approvals/webview/types";
import { ChatView } from "./components/ChatView";
import { ElicitationModal } from "./components/ElicitationModal";
import { InputArea } from "./components/InputArea";
import { DebugInfo } from "./components/DebugInfo";
import { ContextBar } from "./components/ContextBar";
import { TodoPanel } from "./components/TodoPanel";
import { CommandCard } from "../../approvals/webview/components/CommandCard";
import { WriteCard } from "../../approvals/webview/components/WriteCard";
import { RenameCard } from "../../approvals/webview/components/RenameCard";
import { PathCard } from "../../approvals/webview/components/PathCard";
import { McpCard } from "../../approvals/webview/components/McpCard";
import { ModeSwitchCard } from "../../approvals/webview/components/ModeSwitchCard";
import { QuestionCard } from "./components/QuestionCard";
import { SessionHistory } from "./components/SessionHistory";
import { BackgroundSessionStrip } from "./components/BackgroundSessionStrip";
import type { BgSessionInfoProps } from "./components/BackgroundSessionStrip";

// Model context window sizes
const MODEL_MAX_TOKENS: Record<string, number> = {
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
};
const DEFAULT_MAX_TOKENS = 200_000;

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

interface AppState {
  messages: ChatMessage[];
  chatState: ChatState;
  streaming: boolean;
  thinkingEnabled: boolean;
  lastInputTokens: number;
  lastOutputTokens: number;
  lastCacheReadTokens: number;
  debugInfo: Record<string, string | number> | null;
  systemPrompt: string | null;
  loadedInstructions: Array<{ source: string; chars: number }> | null;
  todos: TodoItem[];
  modes: ModeInfo[];
  slashCommands: SlashCommandInfo[];
  messageQueue: Array<{ id: string; text: string }>;
  questionRequest: { id: string; questions: Question[] } | null;
}

type AppAction =
  | { type: "SET_STATE"; state: ChatState }
  | {
      type: "SET_DEBUG_INFO";
      info: Record<string, string | number>;
      systemPrompt?: string;
      loadedInstructions?: Array<{ source: string; chars: number }>;
    }
  | { type: "ADD_USER_MESSAGE"; text: string }
  | { type: "THINKING_START"; thinkingId: string }
  | { type: "THINKING_DELTA"; thinkingId: string; text: string }
  | { type: "THINKING_END"; thinkingId: string }
  | { type: "TEXT_DELTA"; text: string }
  | {
      type: "API_REQUEST";
      requestId: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      durationMs: number;
      timeToFirstToken: number;
    }
  | { type: "TOOL_START"; toolCallId: string; toolName: string }
  | { type: "TOOL_INPUT_DELTA"; toolCallId: string; partialJson: string }
  | {
      type: "TOOL_COMPLETE";
      toolCallId: string;
      toolName: string;
      result: string;
      durationMs: number;
    }
  | { type: "TODO_UPDATE"; todos: TodoItem[] }
  | { type: "ADD_ANNOTATION"; text: string; badge: "follow-up" | "rejection" }
  | { type: "ERROR"; error: string; retryable: boolean }
  | { type: "DONE" }
  | { type: "NEW_SESSION" }
  | { type: "TOGGLE_THINKING" }
  | { type: "SET_MODES"; modes: ModeInfo[] }
  | { type: "SET_SLASH_COMMANDS"; commands: SlashCommandInfo[] }
  | { type: "ENQUEUE_MESSAGE"; id: string; text: string }
  | { type: "EDIT_QUEUE_MESSAGE"; id: string; text: string }
  | { type: "REMOVE_FROM_QUEUE"; id: string }
  | { type: "CLEAR_QUEUE" }
  | { type: "ADD_INTERJECTION"; text: string }
  | { type: "SET_QUESTION"; id: string; questions: Question[] }
  | { type: "CLEAR_QUESTION" }
  | {
      type: "ADD_CONDENSE";
      prevInputTokens: number;
      newInputTokens: number;
      durationMs: number;
    }
  | { type: "ADD_CONDENSE_ERROR"; errorMessage: string }
  | { type: "ADD_WARNING"; message: string }
  | {
      type: "LOAD_SESSION";
      sessionId: string;
      title: string;
      mode: string;
      messages: ChatMessage[];
      lastInputTokens?: number;
      lastOutputTokens?: number;
      checkpoints?: Array<{ turnIndex: number; checkpointId: string }>;
    }
  | { type: "SET_CHECKPOINT"; checkpointId: string; turnIndex: number }
  | { type: "CONDENSE_START" }
  | { type: "CLEAR_ERROR" };

/**
 * Convert persisted AgentMessage[] (Anthropic API format) to ChatMessage[] (webview display format).
 * Tool-result user messages are filtered out as they're internal plumbing.
 * Condense summary messages are rendered as condense rows.
 */
function agentMessagesToChatMessages(raw: unknown[]): ChatMessage[] {
  // First pass: collect tool results keyed by tool_use_id
  const toolResults = new Map<string, string>();
  for (const msg of raw) {
    const m = msg as { role: string; content: unknown };
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const block of m.content as Array<{
        type: string;
        tool_use_id?: string;
        content?: unknown;
      }>) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const text = Array.isArray(block.content)
            ? (block.content as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join("\n")
            : typeof block.content === "string"
              ? block.content
              : "";
          toolResults.set(block.tool_use_id, text);
        }
      }
    }
  }

  // Second pass: build ChatMessages
  const result: ChatMessage[] = [];
  for (const msg of raw) {
    const m = msg as { role: string; content: unknown; isSummary?: boolean };
    if (m.role === "user") {
      if (typeof m.content === "string") {
        result.push({
          id: crypto.randomUUID(),
          role: "user",
          content: m.content,
          timestamp: Date.now(),
          blocks: [],
        });
      }
      // Skip tool_result arrays — they're internal and shouldn't be displayed
    } else if (m.role === "assistant") {
      if (m.isSummary) {
        // Condense summary — render as a condense row
        const summaryText =
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? (m.content as Array<{ type: string; text?: string }>)
                  .filter((b) => b.type === "text")
                  .map((b) => b.text ?? "")
                  .join("")
              : "";
        result.push({
          id: crypto.randomUUID(),
          role: "condense",
          content: "",
          timestamp: Date.now(),
          blocks: [],
          condenseInfo: {
            prevInputTokens: 0,
            newInputTokens: 0,
            // Show the summary text as a hint
            errorMessage: undefined,
          },
        });
        // Also add a text message with the summary so it's visible
        if (summaryText) {
          result.push({
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            timestamp: Date.now(),
            blocks: [{ type: "text", text: summaryText }],
          });
        }
      } else {
        const blocks: ContentBlock[] = [];
        const contentArr = Array.isArray(m.content) ? m.content : [];
        for (const block of contentArr as Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
          thinking?: string;
        }>) {
          if (block.type === "text" && block.text) {
            blocks.push({ type: "text", text: block.text });
          } else if (block.type === "thinking" && block.thinking) {
            blocks.push({
              type: "thinking",
              id: block.id ?? crypto.randomUUID(),
              text: block.thinking,
              complete: true,
            });
          } else if (block.type === "tool_use") {
            const toolId = block.id ?? crypto.randomUUID();
            blocks.push({
              type: "tool_call",
              id: toolId,
              name: block.name ?? "",
              inputJson: JSON.stringify(block.input ?? {}),
              result: toolResults.get(toolId) ?? "",
              complete: true,
            });
          }
        }
        if (blocks.length > 0) {
          result.push({
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            timestamp: Date.now(),
            blocks,
          });
        }
      }
    }
  }
  return result;
}

/** Ensure the last message is an assistant message with blocks. */
function ensureAssistant(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") return messages;
  return [
    ...messages,
    {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [],
    },
  ];
}

/** Get the last block of a given type, or null. */
function lastBlock(blocks: ContentBlock[], type: string) {
  const last = blocks[blocks.length - 1];
  return last?.type === type ? last : null;
}

/** Clone messages array with cloned last message. */
function cloneLast(messages: ChatMessage[]): {
  msgs: ChatMessage[];
  last: ChatMessage;
} {
  const msgs = [...messages];
  const last = {
    ...msgs[msgs.length - 1],
    blocks: [...msgs[msgs.length - 1].blocks],
  };
  msgs[msgs.length - 1] = last;
  return { msgs, last };
}

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_STATE":
      return {
        ...state,
        chatState: action.state,
        streaming: action.state.streaming,
      };

    case "SET_DEBUG_INFO":
      return {
        ...state,
        debugInfo: action.info,
        systemPrompt: action.systemPrompt ?? state.systemPrompt,
        loadedInstructions:
          action.loadedInstructions ?? state.loadedInstructions,
      };

    case "ADD_USER_MESSAGE":
      return {
        ...state,
        streaming: true,
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            role: "user",
            content: action.text,
            timestamp: Date.now(),
            blocks: [],
          },
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            timestamp: Date.now(),
            blocks: [],
          },
        ],
      };

    case "ADD_ANNOTATION":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            role: "user",
            content: action.text,
            badge: action.badge,
            timestamp: Date.now(),
            blocks: [],
          },
        ],
      };

    case "THINKING_START": {
      const all = ensureAssistant(state.messages);
      const { msgs, last } = cloneLast(all);
      last.blocks.push({
        type: "thinking",
        id: action.thinkingId,
        text: "",
        complete: false,
      });
      return { ...state, messages: msgs };
    }

    case "THINKING_DELTA": {
      const { msgs, last } = cloneLast(state.messages);
      last.blocks = last.blocks.map((b) =>
        b.type === "thinking" && b.id === action.thinkingId
          ? { ...b, text: b.text + action.text }
          : b,
      );
      return { ...state, messages: msgs };
    }

    case "THINKING_END": {
      const { msgs, last } = cloneLast(state.messages);
      last.blocks = last.blocks.map((b) =>
        b.type === "thinking" && b.id === action.thinkingId
          ? { ...b, complete: true }
          : b,
      );
      return { ...state, messages: msgs };
    }

    case "TOOL_START": {
      const all = ensureAssistant(state.messages);
      const { msgs, last } = cloneLast(all);
      last.blocks.push({
        type: "tool_call",
        id: action.toolCallId,
        name: action.toolName,
        inputJson: "",
        result: "",
        complete: false,
      });
      return { ...state, messages: msgs };
    }

    case "TOOL_INPUT_DELTA": {
      const { msgs, last } = cloneLast(state.messages);
      last.blocks = last.blocks.map((b) =>
        b.type === "tool_call" && b.id === action.toolCallId
          ? { ...b, inputJson: b.inputJson + action.partialJson }
          : b,
      );
      return { ...state, messages: msgs };
    }

    case "TOOL_COMPLETE": {
      const { msgs, last } = cloneLast(state.messages);
      last.blocks = last.blocks.map((b) =>
        b.type === "tool_call" && b.id === action.toolCallId
          ? {
              ...b,
              result: action.result,
              complete: true,
              durationMs: action.durationMs,
            }
          : b,
      );
      return { ...state, messages: msgs };
    }

    case "TEXT_DELTA": {
      const all = ensureAssistant(state.messages);
      const { msgs, last } = cloneLast(all);
      // Append to existing text block or start a new one
      const tail = lastBlock(last.blocks, "text");
      if (tail && tail.type === "text") {
        last.blocks[last.blocks.length - 1] = {
          ...tail,
          text: tail.text + action.text,
        };
      } else {
        last.blocks.push({ type: "text", text: action.text });
      }
      return { ...state, messages: msgs };
    }

    case "API_REQUEST": {
      if (state.messages.length === 0) return state;
      const { msgs, last } = cloneLast(state.messages);
      last.apiRequest = {
        requestId: action.requestId,
        model: action.model,
        inputTokens: action.inputTokens,
        outputTokens: action.outputTokens,
        durationMs: action.durationMs,
        timeToFirstToken: action.timeToFirstToken,
      };
      return {
        ...state,
        messages: msgs,
        lastInputTokens: action.inputTokens,
        lastOutputTokens: action.outputTokens,
        lastCacheReadTokens: action.cacheReadTokens,
      };
    }

    case "TODO_UPDATE":
      return {
        ...state,
        todos: Array.isArray(action.todos) ? action.todos : [],
      };

    case "ERROR": {
      const all = ensureAssistant(state.messages);
      const { msgs, last } = cloneLast(all);
      last.error = { message: action.error, retryable: action.retryable };
      return { ...state, streaming: false, messages: msgs };
    }

    case "CLEAR_ERROR": {
      // Remove the error from the last message and set streaming=true for retry
      if (state.messages.length === 0) return state;
      const all2 = [...state.messages];
      const lastMsg2 = { ...all2[all2.length - 1] };
      delete lastMsg2.error;
      all2[all2.length - 1] = lastMsg2;
      return { ...state, messages: all2, streaming: true };
    }

    case "DONE":
      return { ...state, streaming: false };

    case "NEW_SESSION":
      return {
        ...state,
        messages: [],
        streaming: false,
        lastInputTokens: 0,
        lastOutputTokens: 0,
        lastCacheReadTokens: 0,
        todos: [],
        messageQueue: [],
      };

    case "TOGGLE_THINKING":
      return { ...state, thinkingEnabled: !state.thinkingEnabled };

    case "SET_MODES":
      return {
        ...state,
        modes: Array.isArray(action.modes) ? action.modes : state.modes,
      };

    case "SET_SLASH_COMMANDS":
      return {
        ...state,
        slashCommands: Array.isArray(action.commands)
          ? action.commands
          : state.slashCommands,
      };

    case "ENQUEUE_MESSAGE":
      return {
        ...state,
        messageQueue: [
          ...state.messageQueue,
          { id: action.id, text: action.text },
        ],
      };

    case "EDIT_QUEUE_MESSAGE":
      return {
        ...state,
        messageQueue: state.messageQueue.map((q) =>
          q.id === action.id ? { ...q, text: action.text } : q,
        ),
      };

    case "REMOVE_FROM_QUEUE":
      return {
        ...state,
        messageQueue: state.messageQueue.filter((q) => q.id !== action.id),
      };

    case "CLEAR_QUEUE":
      return { ...state, messageQueue: [] };

    case "ADD_INTERJECTION":
      // Insert user interjection bubble mid-run without resetting streaming state
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            role: "user" as const,
            content: action.text,
            timestamp: Date.now(),
            blocks: [],
          },
        ],
      };

    case "SET_QUESTION":
      return {
        ...state,
        questionRequest: { id: action.id, questions: action.questions },
      };

    case "CLEAR_QUESTION":
      return { ...state, questionRequest: null };

    case "CONDENSE_START": {
      // Add a pending condense row — replaced with final stats when complete.
      // Set streaming: true so the input area queues messages during condense
      // (prevents racing with message history changes).
      const tail = state.messages[state.messages.length - 1];
      const base =
        tail?.role === "assistant" && tail.blocks.length === 0 && !tail.error
          ? state.messages.slice(0, -1)
          : state.messages;
      return {
        ...state,
        streaming: true,
        messages: [
          ...base,
          {
            id: crypto.randomUUID(),
            role: "condense" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [],
            condenseInfo: {
              prevInputTokens: 0,
              newInputTokens: 0,
              condensing: true,
            },
          },
        ],
      };
    }

    case "ADD_CONDENSE": {
      // Remove any trailing empty assistant placeholder (added optimistically by ADD_USER_MESSAGE)
      // Also remove the pending condense row (condensing: true) if present
      const filtered = state.messages.filter(
        (m) => !(m.role === "condense" && m.condenseInfo?.condensing),
      );
      return {
        ...state,
        messages: [
          ...filtered,
          {
            id: crypto.randomUUID(),
            role: "condense" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [],
            condenseInfo: {
              prevInputTokens: action.prevInputTokens,
              newInputTokens: action.newInputTokens,
              durationMs: action.durationMs,
            },
          },
        ],
        lastInputTokens: action.newInputTokens,
      };
    }

    case "ADD_WARNING": {
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            role: "warning" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [],
            warningMessage: action.message,
          },
        ],
      };
    }

    case "ADD_CONDENSE_ERROR": {
      const filtered = state.messages.filter(
        (m) => !(m.role === "condense" && m.condenseInfo?.condensing),
      );
      return {
        ...state,
        messages: [
          ...filtered,
          {
            id: crypto.randomUUID(),
            role: "condense" as const,
            content: "",
            timestamp: Date.now(),
            blocks: [],
            condenseInfo: {
              prevInputTokens: 0,
              newInputTokens: 0,
              errorMessage: action.errorMessage,
            },
          },
        ],
      };
    }

    case "LOAD_SESSION": {
      // Apply checkpoint IDs to user messages if provided
      let msgs = action.messages;
      if (action.checkpoints && action.checkpoints.length > 0) {
        msgs = [...msgs];
        for (const cp of action.checkpoints) {
          let userCount = 0;
          for (let i = 0; i < msgs.length; i++) {
            if (msgs[i].role === "user") {
              if (userCount === cp.turnIndex) {
                msgs[i] = { ...msgs[i], checkpointId: cp.checkpointId };
                break;
              }
              userCount++;
            }
          }
        }
      }
      return {
        ...state,
        messages: msgs,
        streaming: false,
        lastInputTokens: action.lastInputTokens ?? 0,
        lastOutputTokens: action.lastOutputTokens ?? 0,
        todos: [],
        messageQueue: [],
        questionRequest: null,
        chatState: {
          ...state.chatState,
          sessionId: action.sessionId,
          mode: action.mode,
          streaming: false,
        },
      };
    }

    case "SET_CHECKPOINT": {
      // Attach checkpointId to the most recent user message (turnIndex = its position)
      const msgs = [...state.messages];
      // Find the user message at the given turnIndex (0-based index into user messages)
      let userCount = 0;
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].role === "user") {
          if (userCount === action.turnIndex) {
            msgs[i] = { ...msgs[i], checkpointId: action.checkpointId };
            break;
          }
          userCount++;
        }
      }
      return { ...state, messages: msgs };
    }

    default:
      return state;
  }
}

const initialState: AppState = {
  messages: [],
  chatState: {
    sessionId: null,
    mode: "code",
    model: "claude-sonnet-4-6",
    streaming: false,
  },
  streaming: false,
  thinkingEnabled: true,
  lastInputTokens: 0,
  lastOutputTokens: 0,
  lastCacheReadTokens: 0,
  debugInfo: null,
  systemPrompt: null,
  loadedInstructions: null,
  todos: [],
  modes: [
    { slug: "code", name: "Code", icon: "code" },
    { slug: "architect", name: "Architect", icon: "organization" },
    { slug: "ask", name: "Ask", icon: "question" },
    { slug: "debug", name: "Debug", icon: "debug" },
  ],
  slashCommands: [],
  messageQueue: [],
  questionRequest: null,
};

export interface Injection {
  type: "prompt" | "attachment" | "context";
  prompt?: string;
  attachments?: string[];
  autoSubmit?: boolean;
  path?: string;
  context?: string;
}

export function App({ vscodeApi }: { vscodeApi: VsCodeApi }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state.chatState);
  stateRef.current = state.chatState;
  const messageQueueRef = useRef(state.messageQueue);
  messageQueueRef.current = state.messageQueue;
  const thinkingEnabledRef = useRef(state.thinkingEnabled);
  thinkingEnabledRef.current = state.thinkingEnabled;
  // Guards against stale delta events arriving after agentDone (stop race condition).
  // Set true when a turn starts, false when agentDone fires.
  const streamingRef = useRef(false);
  const [injection, setInjection] = useState<Injection | null>(null);
  const [shiftDragOver, setShiftDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const [mcpStatusInfos, setMcpStatusInfos] = useState<Array<{
    name: string;
    status: string;
    error?: string;
    toolCount: number;
    resourceCount: number;
    promptCount: number;
  }> | null>(null);
  const [elicitation, setElicitation] = useState<{
    id: string;
    serverName: string;
    message: string;
    fields: Record<
      string,
      {
        type: "string" | "number" | "boolean";
        title?: string;
        description?: string;
        enum?: string[];
        default?: unknown;
        minimum?: number;
        maximum?: number;
      }
    >;
    required: string[];
  } | null>(null);
  const [sessionHistory, setSessionHistory] = useState<SessionSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [forwardedApproval, setForwardedApproval] =
    useState<ApprovalRequest | null>(null);
  const forwardedFollowUpRef = useRef("");
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState("");
  const [bgSessions, setBgSessions] = useState<BgSessionInfoProps[]>([]);
  const [expandedQueueIds, setExpandedQueueIds] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data as ExtensionMessage;

      switch (msg.type) {
        case "stateUpdate":
          dispatch({ type: "SET_STATE", state: msg.state });
          break;
        case "agentThinkingStart":
          if (!streamingRef.current) break;
          dispatch({ type: "THINKING_START", thinkingId: msg.thinkingId });
          break;
        case "agentThinkingDelta":
          if (!streamingRef.current) break;
          dispatch({
            type: "THINKING_DELTA",
            thinkingId: msg.thinkingId,
            text: msg.text,
          });
          break;
        case "agentThinkingEnd":
          if (!streamingRef.current) break;
          dispatch({ type: "THINKING_END", thinkingId: msg.thinkingId });
          break;
        case "agentToolStart":
          if (!streamingRef.current) break;
          dispatch({
            type: "TOOL_START",
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
          });
          break;
        case "agentToolInputDelta":
          if (!streamingRef.current) break;
          dispatch({
            type: "TOOL_INPUT_DELTA",
            toolCallId: msg.toolCallId,
            partialJson: msg.partialJson,
          });
          break;
        case "agentToolComplete":
          if (!streamingRef.current) break;
          dispatch({
            type: "TOOL_COMPLETE",
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            result: msg.result,
            durationMs: msg.durationMs,
          });
          break;
        case "agentUserAnnotation":
          if (!streamingRef.current) break;
          dispatch({
            type: "ADD_ANNOTATION",
            text: msg.text,
            badge: msg.badge,
          });
          break;
        case "agentTextDelta":
          if (!streamingRef.current) break;
          dispatch({ type: "TEXT_DELTA", text: msg.text });
          break;
        case "agentApiRequest":
          if (!streamingRef.current) break;
          dispatch({
            type: "API_REQUEST",
            requestId: msg.requestId,
            model: msg.model,
            inputTokens: msg.inputTokens,
            outputTokens: msg.outputTokens,
            cacheReadTokens: msg.cacheReadTokens,
            durationMs: msg.durationMs,
            timeToFirstToken: msg.timeToFirstToken,
          });
          break;
        case "agentError":
          streamingRef.current = false;
          dispatch({
            type: "ERROR",
            error: msg.error,
            retryable: msg.retryable,
          });
          break;
        case "agentTodoUpdate":
          dispatch({ type: "TODO_UPDATE", todos: msg.todos });
          break;
        case "agentDone": {
          streamingRef.current = false;
          dispatch({ type: "DONE" });
          dispatch({ type: "CLEAR_QUESTION" });
          const queue = messageQueueRef.current;
          if (queue.length > 0) {
            const combined = queue.map((q) => q.text).join("\n\n");
            messageQueueRef.current = [];
            dispatch({ type: "CLEAR_QUEUE" });
            setTimeout(() => {
              streamingRef.current = true;
              dispatch({ type: "ADD_USER_MESSAGE", text: combined });
              vscodeApi.postMessage({
                command: "agentSend",
                text: combined,
                attachments: [],
                sessionId: stateRef.current.sessionId,
                mode: stateRef.current.mode,
                thinkingEnabled: thinkingEnabledRef.current,
              });
            }, 0);
          }
          break;
        }
        case "agentDebugInfo":
          dispatch({
            type: "SET_DEBUG_INFO",
            info: msg.info,
            systemPrompt: msg.systemPrompt,
            loadedInstructions: msg.loadedInstructions,
          });
          break;
        case "agentInjectPrompt":
          setInjection({
            type: "prompt",
            prompt: msg.prompt,
            attachments: msg.attachments,
            autoSubmit: msg.autoSubmit,
          });
          break;
        case "agentInjectAttachment":
          setInjection({ type: "attachment", path: msg.path });
          break;
        case "agentInjectContext":
          setInjection({ type: "context", context: msg.context });
          break;
        case "agentModesUpdate":
          dispatch({ type: "SET_MODES", modes: msg.modes });
          break;
        case "agentSlashCommandsUpdate":
          dispatch({ type: "SET_SLASH_COMMANDS", commands: msg.commands });
          break;
        case "agentModeSwitchRequest":
          // Agent requested a mode switch — create a new session in the new mode
          // but do NOT clear the current chat history (it stays visible while the
          // new session is being created; the next stateUpdate will set the new sessionId)
          vscodeApi.postMessage({ command: "agentNewSession", mode: msg.mode });
          break;
        case "agentElicitationRequest":
          setElicitation({
            id: msg.id,
            serverName: msg.serverName,
            message: msg.message,
            fields: msg.fields,
            required: msg.required,
          });
          break;
        case "agentMcpStatus":
          if (msg.open) {
            // /mcp-status command — always open the panel
            setMcpStatusInfos(msg.infos);
          } else {
            // live update from onStatusChange — only refresh if already open
            setMcpStatusInfos((prev) => (prev !== null ? msg.infos : prev));
          }
          break;
        case "showApproval":
          setForwardedApproval(msg.request as ApprovalRequest);
          break;
        case "idle":
          setForwardedApproval(null);
          break;

        case "agentCondense":
          dispatch({
            type: "ADD_CONDENSE",
            prevInputTokens: msg.prevInputTokens,
            newInputTokens: msg.newInputTokens,
            durationMs: msg.durationMs,
          });
          break;

        case "agentCondenseStart":
          dispatch({ type: "CONDENSE_START" });
          break;

        case "agentWarning":
          dispatch({
            type: "ADD_WARNING",
            message: msg.message,
          });
          break;

        case "agentCondenseError":
          dispatch({
            type: "ADD_CONDENSE_ERROR",
            errorMessage: msg.error,
          });
          break;

        case "agentQuestionRequest":
          dispatch({
            type: "SET_QUESTION",
            id: msg.id,
            questions: msg.questions,
          });
          break;

        case "agentSessionList":
          setSessionHistory(msg.sessions);
          break;

        case "agentSessionLoaded":
          dispatch({
            type: "LOAD_SESSION",
            sessionId: msg.sessionId,
            title: msg.title,
            mode: msg.mode,
            messages: agentMessagesToChatMessages(msg.messages as unknown[]),
            lastInputTokens: msg.lastInputTokens,
            lastOutputTokens: msg.lastOutputTokens,
            checkpoints: msg.checkpoints,
          });
          setShowHistory(false);
          break;

        case "agentCheckpointCreated":
          dispatch({
            type: "SET_CHECKPOINT",
            checkpointId: msg.checkpointId,
            turnIndex: msg.turnIndex,
          });
          break;

        case "agentInterjection":
          // User message injected mid-run between tool batches
          dispatch({ type: "ADD_INTERJECTION", text: msg.text });
          dispatch({ type: "REMOVE_FROM_QUEUE", id: msg.queueId });
          messageQueueRef.current = messageQueueRef.current.filter(
            (q) => q.id !== msg.queueId,
          );
          break;

        case "agentBgSessionsUpdate":
          setBgSessions(msg.sessions as BgSessionInfoProps[]);
          break;
      }
    };

    window.addEventListener("message", handler);

    // Tell extension we're ready
    vscodeApi.postMessage({ command: "webviewReady" });

    return () => window.removeEventListener("message", handler);
  }, [vscodeApi]);

  const handleSend = useCallback(
    (text: string, attachments: string[] = [], displayText?: string) => {
      // While streaming, enqueue the message instead of sending immediately
      if (state.streaming) {
        const display = displayText ?? text;
        const queueId = crypto.randomUUID();
        dispatch({
          type: "ENQUEUE_MESSAGE",
          id: queueId,
          text: display,
        });
        // Notify extension about this queued item so it can inject it ASAP
        // between tool batches. Only the first pending item will be used.
        vscodeApi.postMessage({
          command: "agentQueueMessage",
          text: display,
          queueId,
          sessionId: stateRef.current.sessionId,
        });
        return;
      }

      // Build message text: prepend attached file references
      let fullText = text;
      if (attachments.length > 0) {
        const fileRefs = attachments.map((p) => `[Attached: ${p}]`).join("\n");
        fullText = fileRefs + "\n\n" + text;
      }
      // displayText is shown in the chat UI; fullText is sent to the agent
      streamingRef.current = true;
      dispatch({ type: "ADD_USER_MESSAGE", text: displayText ?? fullText });
      vscodeApi.postMessage({
        command: "agentSend",
        text: fullText,
        attachments,
        sessionId: stateRef.current.sessionId,
        mode: stateRef.current.mode,
        thinkingEnabled: thinkingEnabledRef.current,
      });
    },
    [vscodeApi, state.streaming, state.thinkingEnabled],
  );

  const handleStop = useCallback(() => {
    if (stateRef.current.sessionId) {
      vscodeApi.postMessage({
        command: "agentStop",
        sessionId: stateRef.current.sessionId,
      });
    }
  }, [vscodeApi]);

  const handleStopBackground = useCallback(
    (sessionId: string) => {
      vscodeApi.postMessage({ command: "agentStop", sessionId });
    },
    [vscodeApi],
  );

  const handleNewSession = useCallback(() => {
    dispatch({ type: "NEW_SESSION" });
    vscodeApi.postMessage({
      command: "agentNewSession",
      mode: stateRef.current.mode,
    });
  }, [vscodeApi]);

  const handleSwitchMode = useCallback(
    (slug: string) => {
      dispatch({ type: "NEW_SESSION" });
      vscodeApi.postMessage({ command: "agentNewSession", mode: slug });
    },
    [vscodeApi],
  );

  const handleSetAgentWriteApproval = useCallback(
    (mode: string) => {
      vscodeApi.postMessage({
        command: "agentSetWriteApproval",
        mode,
      });
    },
    [vscodeApi],
  );

  const handleExecuteBuiltinCommand = useCallback(
    (name: string, args: string) => {
      switch (name) {
        case "new":
          dispatch({ type: "NEW_SESSION" });
          vscodeApi.postMessage({
            command: "agentNewSession",
            mode: stateRef.current.mode,
          });
          break;

        case "mode": {
          const slug = args.trim();
          if (slug) handleSwitchMode(slug);
          break;
        }
        case "model":
          vscodeApi.postMessage({
            command: "agentSetModel",
            model: args.trim(),
          });
          break;
        case "help":
          // Inject a help message as user text so the agent responds
          vscodeApi.postMessage({
            command: "agentSend",
            text: "List all available slash commands and what they do.",
            attachments: [],
            sessionId: stateRef.current.sessionId,
            mode: stateRef.current.mode,
            thinkingEnabled: false,
          });
          break;
        case "mcp":
          // args is "project" or "global" (from the webview sub-picker)
          vscodeApi.postMessage({ command: "agentSlashCommand", name, args });
          break;
        case "mcp-refresh":
        case "mcp-status":
          vscodeApi.postMessage({ command: "agentSlashCommand", name, args });
          break;
        // Phase 4 stubs
        case "condense":
        case "checkpoint":
        case "revert":
          vscodeApi.postMessage({ command: "agentSlashCommand", name, args });
          break;
      }
    },
    [vscodeApi, handleSwitchMode],
  );

  const handleElicitSubmit = useCallback(
    (id: string, values: Record<string, unknown>) => {
      setElicitation(null);
      vscodeApi.postMessage({
        command: "agentElicitationResponse",
        id,
        values,
        cancelled: false,
      });
    },
    [vscodeApi],
  );

  const handleElicitCancel = useCallback(
    (id: string) => {
      setElicitation(null);
      vscodeApi.postMessage({
        command: "agentElicitationResponse",
        id,
        values: {},
        cancelled: true,
      });
    },
    [vscodeApi],
  );

  const handleForwardedApprovalSubmit = useCallback(
    (data: Omit<DecisionMessage, "type">) => {
      setForwardedApproval(null);
      forwardedFollowUpRef.current = "";
      vscodeApi.postMessage({ command: "approvalDecision", ...data });
    },
    [vscodeApi],
  );

  const handleToggleThinking = useCallback(() => {
    dispatch({ type: "TOGGLE_THINKING" });
  }, []);

  const handleExportTranscript = useCallback(() => {
    vscodeApi.postMessage({
      command: "agentExportTranscript",
      messages: state.messages,
    });
  }, [vscodeApi, state.messages]);

  const handleOpenFile = useCallback(
    (path: string, line?: number) => {
      vscodeApi.postMessage({ command: "agentOpenFile", path, line });
    },
    [vscodeApi],
  );

  const handleOpenMermaidPanel = useCallback(
    (source: string) => {
      vscodeApi.postMessage({ command: "agentOpenMermaidPanel", source });
    },
    [vscodeApi],
  );

  const handleRevertCheckpoint = useCallback(
    (sessionId: string, checkpointId: string) => {
      vscodeApi.postMessage({
        command: "agentRevertCheckpoint",
        sessionId,
        checkpointId,
      });
    },
    [vscodeApi],
  );

  const handleRetry = useCallback(() => {
    if (stateRef.current.sessionId) {
      streamingRef.current = true;
      dispatch({ type: "CLEAR_ERROR" });
      vscodeApi.postMessage({
        command: "agentRetry",
        sessionId: stateRef.current.sessionId,
      });
    }
  }, [vscodeApi]);

  const handleShowHistory = useCallback(() => {
    vscodeApi.postMessage({ command: "agentListSessions" });
    setShowHistory((prev) => !prev);
  }, [vscodeApi]);

  const handleLoadSession = useCallback(
    (sessionId: string) => {
      vscodeApi.postMessage({ command: "agentLoadSession", sessionId });
    },
    [vscodeApi],
  );

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      vscodeApi.postMessage({ command: "agentDeleteSession", sessionId });
    },
    [vscodeApi],
  );

  const handleRenameSession = useCallback(
    (sessionId: string, title: string) => {
      vscodeApi.postMessage({
        command: "agentRenameSession",
        sessionId,
        title,
      });
    },
    [vscodeApi],
  );

  const handleCopyFirstPrompt = useCallback(
    (sessionId: string) => {
      handleNewSession();
      vscodeApi.postMessage({ command: "agentCopyFirstPrompt", sessionId });
      setShowHistory(false);
    },
    [vscodeApi, handleNewSession],
  );

  const handleContainerDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (e.shiftKey) {
      setShiftDragOver(true);
    }
  }, []);

  const handleContainerDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (e.shiftKey && e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
    // Update shift state in case user presses/releases shift mid-drag
    setShiftDragOver(e.shiftKey);
  }, []);

  const handleContainerDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setShiftDragOver(false);
    }
  }, []);

  const handleContainerDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setShiftDragOver(false);

      if (!e.shiftKey || !e.dataTransfer) return;

      // Try text/uri-list, then plain text
      let uriList = e.dataTransfer.getData("text/uri-list");
      if (!uriList) {
        const text =
          e.dataTransfer.getData("text/plain") ||
          e.dataTransfer.getData("text");
        if (
          text &&
          (text.startsWith("file://") || text.startsWith("vscode-"))
        ) {
          uriList = text;
        }
      }

      if (!uriList) return;

      const paths = uriList
        .split("\n")
        .map((u) => u.trim())
        .filter((u) => u && !u.startsWith("#"))
        .map((u) => {
          try {
            return decodeURIComponent(new URL(u).pathname);
          } catch {
            return u;
          }
        })
        .filter((p): p is string => !!p);

      if (paths.length > 0) {
        vscodeApi.postMessage({
          command: "agentResolveDroppedFiles",
          paths,
        });
      }
    },
    [vscodeApi],
  );

  return (
    <>
      {elicitation && (
        <ElicitationModal
          id={elicitation.id}
          serverName={elicitation.serverName}
          message={elicitation.message}
          fields={elicitation.fields}
          required={elicitation.required}
          onSubmit={handleElicitSubmit}
          onCancel={handleElicitCancel}
        />
      )}
      <div
        class="chat-container"
        onDragEnter={handleContainerDragEnter}
        onDragOver={handleContainerDragOver}
        onDragLeave={handleContainerDragLeave}
        onDrop={handleContainerDrop}
      >
        {shiftDragOver && (
          <div class="drop-overlay">
            <div class="drop-overlay-content">
              <i class="codicon codicon-attach" />
              <span>Drop to attach files</span>
            </div>
          </div>
        )}
        <div class="chat-header">
          <button
            class="icon-button"
            onClick={handleNewSession}
            title="New Session"
          >
            <i class="codicon codicon-add" />
          </button>
          <button
            class={`icon-button${showHistory ? " active" : ""}`}
            onClick={handleShowHistory}
            title="Session History"
          >
            <i class="codicon codicon-history" />
          </button>
        </div>
        {showHistory && (
          <SessionHistory
            sessions={sessionHistory}
            currentSessionId={state.chatState.sessionId}
            onLoad={handleLoadSession}
            onDelete={handleDeleteSession}
            onRename={handleRenameSession}
            onCopyFirstPrompt={handleCopyFirstPrompt}
            onClose={() => setShowHistory(false)}
          />
        )}
        {state.debugInfo && (
          <DebugInfo
            info={state.debugInfo}
            systemPrompt={state.systemPrompt}
            loadedInstructions={state.loadedInstructions ?? undefined}
          />
        )}
        <ChatView
          messages={state.messages}
          streaming={state.streaming}
          sessionId={state.chatState.sessionId}
          onOpenFile={handleOpenFile}
          onOpenMermaidPanel={handleOpenMermaidPanel}
          onRevertCheckpoint={handleRevertCheckpoint}
          onRetry={handleRetry}
        />
        {state.messageQueue.length > 0 && (
          <div class="queue-panel">
            <div class="queue-header">
              <i class="codicon codicon-list-ordered" />
              <span>Queued ({state.messageQueue.length})</span>
            </div>
            {state.messageQueue.map((item) => (
              <div key={item.id} class="queue-item">
                {editingQueueId === item.id ? (
                  <textarea
                    class="queue-item-textarea"
                    value={editingQueueText}
                    onInput={(e) =>
                      setEditingQueueText(
                        (e.target as HTMLTextAreaElement).value,
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        const trimmed = editingQueueText.trim();
                        if (trimmed) {
                          dispatch({
                            type: "EDIT_QUEUE_MESSAGE",
                            id: item.id,
                            text: trimmed,
                          });
                        }
                        setEditingQueueId(null);
                      } else if (e.key === "Escape") {
                        setEditingQueueId(null);
                      }
                    }}
                    autoFocus
                  />
                ) : (
                  <span
                    class={`queue-item-text${expandedQueueIds.has(item.id) ? " expanded" : ""}`}
                    title="Click to expand/collapse"
                    onClick={() =>
                      setExpandedQueueIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })
                    }
                  >
                    {item.text}
                  </span>
                )}
                <div class="queue-item-actions">
                  {editingQueueId !== item.id && (
                    <button
                      class="icon-button queue-item-edit"
                      title="Edit"
                      onClick={() => {
                        setEditingQueueText(item.text);
                        setEditingQueueId(item.id);
                      }}
                    >
                      <i class="codicon codicon-edit" />
                    </button>
                  )}
                  <button
                    class="icon-button queue-item-remove"
                    title="Remove"
                    onClick={() =>
                      dispatch({ type: "REMOVE_FROM_QUEUE", id: item.id })
                    }
                  >
                    <i class="codicon codicon-close" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {(state.lastInputTokens > 0 || state.lastOutputTokens > 0) && (
          <ContextBar
            inputTokens={state.lastInputTokens}
            outputTokens={state.lastOutputTokens}
            cacheReadTokens={state.lastCacheReadTokens}
            maxContextWindow={
              MODEL_MAX_TOKENS[state.chatState.model] ?? DEFAULT_MAX_TOKENS
            }
            condenseThreshold={state.chatState.condenseThreshold}
          />
        )}
        {mcpStatusInfos && (
          <div class="mcp-status-panel">
            <div class="mcp-status-header">
              <i class="codicon codicon-server" />
              <span>MCP Servers</span>
              <button
                class="mcp-status-close icon-button"
                onClick={() => setMcpStatusInfos(null)}
                title="Dismiss"
              >
                <i class="codicon codicon-close" />
              </button>
            </div>
            {mcpStatusInfos.length === 0 ? (
              <p class="mcp-status-empty">No MCP servers configured.</p>
            ) : (
              <ul class="mcp-status-list">
                {mcpStatusInfos.map((info) => (
                  <li
                    key={info.name}
                    class={`mcp-status-item mcp-status-${info.status}`}
                  >
                    <i
                      class={`codicon ${
                        info.status === "connected"
                          ? "codicon-check"
                          : info.status === "connecting"
                            ? "codicon-loading codicon-modifier-spin"
                            : "codicon-error"
                      }`}
                    />
                    <span class="mcp-status-name">{info.name}</span>
                    <span class="mcp-status-detail">
                      {info.status === "connected"
                        ? [
                            `${info.toolCount} tool${info.toolCount !== 1 ? "s" : ""}`,
                            info.resourceCount > 0 &&
                              `${info.resourceCount} resource${info.resourceCount !== 1 ? "s" : ""}`,
                            info.promptCount > 0 &&
                              `${info.promptCount} prompt${info.promptCount !== 1 ? "s" : ""}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : (info.error ?? info.status)}
                    </span>
                    <span class="mcp-status-actions">
                      {info.status !== "connecting" && (
                        <button
                          class="icon-button"
                          title="Reconnect"
                          onClick={() =>
                            vscodeApi.postMessage({
                              command: "agentMcpAction",
                              serverName: info.name,
                              action: "reconnect",
                            })
                          }
                        >
                          <i class="codicon codicon-refresh" />
                        </button>
                      )}
                      <button
                        class="icon-button"
                        title="Reauthenticate"
                        onClick={() =>
                          vscodeApi.postMessage({
                            command: "agentMcpAction",
                            serverName: info.name,
                            action: "reauthenticate",
                          })
                        }
                      >
                        <i class="codicon codicon-key" />
                      </button>
                      <button
                        class="icon-button mcp-action-disable"
                        title="Disable"
                        onClick={() =>
                          vscodeApi.postMessage({
                            command: "agentMcpAction",
                            serverName: info.name,
                            action: "disable",
                          })
                        }
                      >
                        <i class="codicon codicon-circle-slash" />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {state.todos.length > 0 && <TodoPanel todos={state.todos} />}
        {state.questionRequest && (
          <QuestionCard
            id={state.questionRequest.id}
            questions={state.questionRequest.questions}
            onSubmit={(
              id: string,
              answers: Record<
                string,
                string | string[] | number | boolean | undefined
              >,
              notes: Record<string, string>,
            ) => {
              dispatch({ type: "CLEAR_QUESTION" });
              vscodeApi.postMessage({
                command: "agentQuestionResponse",
                id,
                answers,
                notes,
              });
            }}
          />
        )}
        {forwardedApproval && (
          <div class="approval-panel-embed">
            {forwardedApproval.kind === "command" ? (
              <CommandCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            ) : forwardedApproval.kind === "write" ? (
              <WriteCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            ) : forwardedApproval.kind === "rename" ? (
              <RenameCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            ) : forwardedApproval.kind === "mcp" ? (
              <McpCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            ) : forwardedApproval.kind === "mode-switch" ? (
              <ModeSwitchCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            ) : (
              <PathCard
                request={forwardedApproval}
                submit={handleForwardedApprovalSubmit}
                followUpRef={forwardedFollowUpRef}
              />
            )}
          </div>
        )}
        {state.streaming && (
          <div class="streaming-status-bar">
            <i class="codicon codicon-loading codicon-modifier-spin" />
            <span>Working…</span>
          </div>
        )}
        <BackgroundSessionStrip
          sessions={bgSessions}
          onStop={handleStopBackground}
        />
        <InputArea
          onSend={handleSend}
          onStop={handleStop}
          streaming={state.streaming}
          thinkingEnabled={state.thinkingEnabled}
          onToggleThinking={handleToggleThinking}
          onExportTranscript={handleExportTranscript}
          hasMessages={state.messages.length > 0}
          vscodeApi={vscodeApi}
          injection={injection}
          onInjectionConsumed={() => setInjection(null)}
          slashCommands={state.slashCommands}
          onExecuteBuiltinCommand={handleExecuteBuiltinCommand}
          modes={state.modes}
          currentMode={state.chatState.mode}
          currentModel={state.chatState.model}
          onSwitchMode={handleSwitchMode}
          agentWriteApproval={state.chatState.agentWriteApproval ?? "prompt"}
          onSetAgentWriteApproval={handleSetAgentWriteApproval}
        />
      </div>
    </>
  );
}
