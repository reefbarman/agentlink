import type {
  ChatMessage,
  ChatState,
  ContentBlock,
  ModeInfo,
  ProjectInfo,
  Question,
  QuestionRequest,
  ReasoningEffort,
  SessionSummary,
  SlashCommandInfo,
  TodoItem,
  WebviewModelInfo,
} from "./types.js";
import { expectTypeOf, it } from "vitest";

it("preserves structured-question DTOs through the webview compatibility aliases", () => {
  expectTypeOf<Question>().toEqualTypeOf<
    import("@agentlink/protocol/structured-question").UserQuestion
  >();
  expectTypeOf<QuestionRequest>().toEqualTypeOf<
    import("@agentlink/protocol/structured-question").StructuredQuestionRequest
  >();
});

it("preserves chat-catalog DTOs through the webview compatibility aliases", () => {
  expectTypeOf<ProjectInfo>().toEqualTypeOf<
    import("@agentlink/protocol/chat-catalog").ChatProjectInfo
  >();
  expectTypeOf<ModeInfo>().toEqualTypeOf<
    import("@agentlink/protocol/chat-catalog").ChatModeInfo
  >();
  expectTypeOf<ReasoningEffort>().toEqualTypeOf<
    import("@agentlink/protocol/chat-catalog").ChatReasoningEffort
  >();
  expectTypeOf<WebviewModelInfo>().toEqualTypeOf<
    import("@agentlink/protocol/chat-catalog").ChatModelInfo
  >();
  expectTypeOf<SlashCommandInfo>().toEqualTypeOf<
    import("@agentlink/protocol/chat-catalog").ChatSlashCommandInfo
  >();
});

it("preserves chat-state DTOs through the webview compatibility alias", () => {
  expectTypeOf<ChatState>().toEqualTypeOf<
    import("@agentlink/protocol/chat-state").ChatStateSnapshot
  >();
});

it("preserves chat-session-history DTOs through the webview compatibility alias", () => {
  expectTypeOf<SessionSummary>().toEqualTypeOf<
    import("@agentlink/protocol/chat-session-history").ChatSessionHistorySummary
  >();
});

it("preserves chat-transcript DTOs through the webview compatibility aliases", () => {
  expectTypeOf<ChatMessage>().toEqualTypeOf<
    import("@agentlink/protocol/chat-transcript").ChatMessage
  >();
  expectTypeOf<ContentBlock>().toEqualTypeOf<
    import("@agentlink/protocol/chat-transcript").ContentBlock
  >();
  expectTypeOf<TodoItem>().toEqualTypeOf<
    import("@agentlink/protocol/chat-transcript").TodoItem
  >();
});
