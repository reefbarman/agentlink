import type {
  ChatTabActionAddress as PackageChatTabActionAddress,
  ChatTabWorkspaceSnapshot as PackageChatTabWorkspaceSnapshot,
  ChatWorkspaceViewSnapshot as PackageChatWorkspaceViewSnapshot,
} from "@agentlink/protocol/chat-workspace";
import {
  createChatWorkspaceViewSnapshot,
  getChatTabViewStatus,
  isChatTabSessionBusy,
  parseChatTabActionAddress,
  selectedWorkspaceSessionId,
  type ChatTabActionAddress,
  type ChatTabWorkspaceSnapshot,
  type ChatWorkspaceViewSnapshot,
} from "./chatTabProtocol.js";
import { describe, expectTypeOf, it } from "vitest";

describe("chat tab protocol compatibility", () => {
  it("re-exports package-owned chat workspace contracts", () => {
    expectTypeOf<ChatTabActionAddress>().toEqualTypeOf<PackageChatTabActionAddress>();
    expectTypeOf<ChatTabWorkspaceSnapshot>().toEqualTypeOf<PackageChatTabWorkspaceSnapshot>();
    expectTypeOf<ChatWorkspaceViewSnapshot>().toEqualTypeOf<PackageChatWorkspaceViewSnapshot>();
    expectTypeOf(createChatWorkspaceViewSnapshot).toBeFunction();
    expectTypeOf(getChatTabViewStatus).toBeFunction();
    expectTypeOf(isChatTabSessionBusy).toBeFunction();
    expectTypeOf(parseChatTabActionAddress).toBeFunction();
    expectTypeOf(selectedWorkspaceSessionId).toBeFunction();
  });
});
