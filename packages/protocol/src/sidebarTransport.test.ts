import type {
  ExtensionMessage,
  FeedbackEntry,
  IndexStatusInfo,
  PostCommand,
  RuleEditCommand,
  RuleRemoveCommand,
  SidebarState,
  TrackedCallInfo,
  WebviewCommand,
} from "./sidebarTransport.js";
import { expectTypeOf, it } from "vitest";

import type { ContextHealthSnapshot } from "./contextHealth.js";
import type { SemanticReadinessReason } from "./semanticReadiness.js";

it("pins the sidebar state dependency closure", () => {
  expectTypeOf<SidebarState["contextHealth"]>().toEqualTypeOf<
    ContextHealthSnapshot | undefined
  >();
  expectTypeOf<IndexStatusInfo["readinessReason"]>().toEqualTypeOf<
    SemanticReadinessReason | undefined
  >();
  expectTypeOf<FeedbackEntry["priority"]>().toEqualTypeOf<
    "P0" | "P1" | "P2" | "P3" | undefined
  >();
  expectTypeOf<TrackedCallInfo["parentCallId"]>().toEqualTypeOf<
    string | undefined
  >();
});

it("pins extension-to-webview message discriminants", () => {
  expectTypeOf<ExtensionMessage["type"]>().toEqualTypeOf<
    | "stateUpdate"
    | "updateToolCalls"
    | "updateFeedback"
    | "updateContextHealth"
    | "updateIndexStatus"
  >();
});

it("pins webview-to-extension command discriminants", () => {
  expectTypeOf<RuleEditCommand>().toEqualTypeOf<
    | "editGlobalRule"
    | "editProjectRule"
    | "editSessionRule"
    | "editGlobalPathRule"
    | "editProjectPathRule"
    | "editGlobalWriteRule"
    | "editProjectWriteRule"
  >();
  expectTypeOf<RuleRemoveCommand>().toEqualTypeOf<
    | "removeGlobalRule"
    | "removeProjectRule"
    | "removeSessionRule"
    | "removeGlobalPathRule"
    | "removeProjectPathRule"
    | "removeSessionPathRule"
    | "removeGlobalWriteRule"
    | "removeProjectWriteRule"
    | "removeSessionWriteRule"
  >();
  expectTypeOf<WebviewCommand["command"]>().toEqualTypeOf<
    | "webviewReady"
    | "openSettings"
    | "openOutput"
    | "openBrowserGateway"
    | "addGlobalRule"
    | "clearAllSessions"
    | "refreshFeedback"
    | "clearAllFeedback"
    | "openFeedbackFile"
    | "rebuildIndex"
    | "cancelIndex"
    | "resumeIndex"
    | "setOpenaiApiKey"
    | "setOpenaiModelsAndEmbeddingsApiKey"
    | "setWriteApproval"
    | RuleEditCommand
    | RuleRemoveCommand
    | "clearSessionRules"
    | "cancelToolCall"
    | "completeToolCall"
    | "continueToolCallInBackground"
    | "deleteFeedbackEntry"
    | "triageFeedbackEntry"
    | "setupSemanticSearch"
  >();
  expectTypeOf<
    Extract<WebviewCommand, { command: "setWriteApproval" }>
  >().toEqualTypeOf<{
    command: "setWriteApproval";
    mode: "prompt" | "session" | "project" | "global";
  }>();
  expectTypeOf<
    Extract<WebviewCommand, { command: "editSessionRule" }>
  >().toEqualTypeOf<{
    command: "editSessionRule";
    pattern: string;
    mode: string;
    decision?: "allow" | "prompt" | "forbidden";
    sessionId: string;
  }>();
});

it("pins typed sidebar command posting", () => {
  const postCommand = (() => undefined) as PostCommand;
  expectTypeOf(postCommand).toBeCallableWith("webviewReady");
  expectTypeOf(postCommand).toBeCallableWith("setWriteApproval", {
    mode: "project",
  });
  expectTypeOf(postCommand).toBeCallableWith("editSessionRule", {
    pattern: "npm test",
    mode: "prefix",
    decision: "allow",
    sessionId: "session-1",
  });
  // @ts-expect-error simple commands never accept data
  postCommand("openSettings", {});
  // @ts-expect-error data commands require their payload
  postCommand("setWriteApproval");
});
