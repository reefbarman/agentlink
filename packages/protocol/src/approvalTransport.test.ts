import type {
  ApprovalKind,
  ApprovalProjectContext,
  ApprovalRequest,
  CommandRecoveryAttempt,
  CommandReviewSummary,
  CommandTierLevel,
  DecisionMessage,
  ExtensionMessage,
  InlineCommandFilePreview,
  MemoryOperation,
  MemoryScope,
  MemoryTier,
  NetworkReviewSummary,
  RuleEntry,
  SubCommandEntry,
  SuggestRegexMessage,
} from "./approvalTransport.js";
import type {
  ManagedNetworkRequest,
  TerminalExecutionSecuritySummary,
} from "./terminalSecurity.js";
import { expect, expectTypeOf, it } from "vitest";

it("pins approval kinds and dependent protocol DTOs", () => {
  expectTypeOf<ApprovalKind>().toEqualTypeOf<
    | "command"
    | "network"
    | "path"
    | "write"
    | "rename"
    | "mcp"
    | "mode-switch"
    | "memory"
    | "worktree"
    | "hook"
  >();
  expectTypeOf<MemoryOperation>().toEqualTypeOf<"add" | "update" | "remove">();
  expectTypeOf<ApprovalRequest["memoryScope"]>().toEqualTypeOf<
    MemoryScope | undefined
  >();
  expectTypeOf<ApprovalRequest["memoryTier"]>().toEqualTypeOf<
    MemoryTier | undefined
  >();
  expectTypeOf<ApprovalRequest["security"]>().toEqualTypeOf<
    TerminalExecutionSecuritySummary | undefined
  >();
  expectTypeOf<ApprovalRequest["managedNetwork"]>().toEqualTypeOf<
    ManagedNetworkRequest | undefined
  >();
  expectTypeOf<CommandTierLevel>().toEqualTypeOf<
    "safe" | "sensitive" | "dangerous"
  >();
  expectTypeOf<ApprovalProjectContext>().toEqualTypeOf<{
    projectId: string;
    displayName: string;
    availability: "available" | "missing" | "unavailable" | "invalid";
  }>();
  expectTypeOf<InlineCommandFilePreview>().toEqualTypeOf<{
    name: string;
    path: string;
    ext?: string;
    bytes: number;
    sha256: string;
    truncated: boolean;
    executable: boolean;
    preview: string;
  }>();
});

it("pins command and reviewer evidence", () => {
  expectTypeOf<CommandRecoveryAttempt>().toEqualTypeOf<{
    denialOperation: string;
    denialReason: string;
    firstAttemptRoute: "sandbox" | "native";
    commandSent: boolean | "unknown";
    processLaunched: boolean | "unknown";
    mayHaveSideEffects: boolean | "unknown";
  }>();
  expectTypeOf<CommandReviewSummary>().toEqualTypeOf<{
    status: "reviewed" | "unavailable" | "timed_out" | "cancelled" | "invalid";
    outcome: "allow" | "deny";
    risk: "low" | "medium" | "high" | "critical";
    userAuthorization: "unknown" | "low" | "medium" | "high";
    rationale: string;
    model: string;
  }>();
  expectTypeOf<NetworkReviewSummary>().toEqualTypeOf<CommandReviewSummary>();
  expectTypeOf<NonNullable<SubCommandEntry["existingRule"]>>().toEqualTypeOf<{
    pattern: string;
    mode: "prefix" | "exact" | "regex";
    decision?: "allow" | "prompt" | "forbidden";
    scope: "session" | "project" | "global";
  }>();
  expectTypeOf<RuleEntry>().toEqualTypeOf<{
    pattern: string;
    mode: "prefix" | "exact" | "regex" | "skip";
    decision?: "allow" | "prompt" | "forbidden";
    scope: "session" | "project" | "global" | "skip";
  }>();
});

it("pins nested approval request members", () => {
  expectTypeOf<ApprovalRequest["sourceProject"]>().toEqualTypeOf<
    ApprovalProjectContext | undefined
  >();
  expectTypeOf<ApprovalRequest["targetProject"]>().toEqualTypeOf<
    ApprovalProjectContext | undefined
  >();
  expectTypeOf<ApprovalRequest["subCommands"]>().toEqualTypeOf<
    SubCommandEntry[] | undefined
  >();
  expectTypeOf<ApprovalRequest["inlineFiles"]>().toEqualTypeOf<
    InlineCommandFilePreview[] | undefined
  >();
  expectTypeOf<ApprovalRequest["affectedFiles"]>().toEqualTypeOf<
    Array<{ path: string; changes: number }> | undefined
  >();
  expectTypeOf<ApprovalRequest["toolOrigin"]>().toEqualTypeOf<
    "mcp" | "acp" | undefined
  >();
  for (const choices of [
    null as unknown as ApprovalRequest["writeChoices"],
    null as unknown as ApprovalRequest["mcpChoices"],
    null as unknown as ApprovalRequest["hookChoices"],
    null as unknown as ApprovalRequest["worktreeChoices"],
  ]) {
    expectTypeOf(choices).toEqualTypeOf<
      | Array<{
          label: string;
          value: string;
          isPrimary?: boolean;
          isDanger?: boolean;
        }>
      | undefined
    >();
  }
});

it("pins bidirectional approval message shapes", () => {
  expectTypeOf<
    Extract<ExtensionMessage, { type: "showApproval" }>
  >().toEqualTypeOf<{
    type: "showApproval";
    request: ApprovalRequest;
  }>();
  expectTypeOf<Extract<ExtensionMessage, { type: "idle" }>>().toEqualTypeOf<{
    type: "idle";
  }>();
  expectTypeOf<
    Extract<ExtensionMessage, { type: "regexSuggestion" }>
  >().toEqualTypeOf<{
    type: "regexSuggestion";
    requestId: string;
    pattern?: string;
    error?: string;
  }>();
  expectTypeOf<DecisionMessage>().toEqualTypeOf<{
    type: "decision";
    id: string;
    approvalKind?: ApprovalKind;
    decision: string;
    editedCommand?: string;
    rejectionReason?: string;
    rulePattern?: string;
    ruleMode?: string;
    rules?: RuleEntry[];
    trustScope?: string;
    editedContent?: string;
    memoryTier?: MemoryTier;
    memoryScope?: MemoryScope;
    memoryName?: string;
    followUp?: string;
  }>();
  expectTypeOf<SuggestRegexMessage>().toEqualTypeOf<{
    type: "suggestRegex";
    requestId: string;
    approvalId: string;
    subCommand: string;
    fullCommand: string;
  }>();
});

it("keeps complete approval requests serializable", () => {
  const request: ApprovalRequest = {
    id: "approval-1",
    kind: "network",
    backgroundTask: "Run tests",
    managedNetwork: {
      requestId: "network-1",
      sessionId: "session-1",
      auditId: "audit-1",
      terminalId: "terminal-1",
      commandId: "command-1",
      generation: 1,
      command: "npm test",
      cwd: "/workspace",
      host: "registry.npmjs.org",
      protocol: "https",
      port: 443,
      address: "104.16.30.34",
      family: 4,
      dnsAnswers: [{ address: "104.16.30.34", family: 4 }],
      destinationClass: "public",
    },
    networkReview: {
      status: "reviewed",
      outcome: "allow",
      risk: "low",
      userAuthorization: "high",
      rationale: "The user requested package validation.",
      model: "review-model",
    },
  };

  expect(JSON.parse(JSON.stringify(request))).toEqual(request);
});
