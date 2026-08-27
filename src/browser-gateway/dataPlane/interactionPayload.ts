import type {
  ApprovalProjectContext,
  ApprovalRequest,
  CommandRecoveryAttempt,
  CommandReviewSummary,
  InlineCommandFilePreview,
  SubCommandEntry,
} from "../../approvals/webview/types.js";
import type { Question, QuestionRequest } from "../../agent/webview/types.js";
import type { TerminalExecutionSecuritySummary } from "../../core/capabilities/terminal.js";
import type {
  McpElicitationField,
  McpElicitationOption,
  McpFormElicitationRequest,
} from "../../shared/mcpElicitation.js";
import type { McpUrlElicitationRequest } from "../../shared/mcpUrlElicitation.js";

export interface BrowserGatewayOwnerQuestionProgressPayload {
  id: string;
  step: number;
  answers: Record<
    string,
    string | readonly string[] | number | boolean | undefined
  >;
  notes: Record<string, string>;
  origin: string;
}

/**
 * Full browser interaction state attached to one primary interaction summary.
 * Legacy browser state permits these requests to coexist, so the detail must
 * not collapse them into a discriminated union. The aggregate crosses the
 * wire only through an authenticated, expiring, generation-bound interaction
 * detail and is reconstructed field-by-field at both ends of that boundary.
 */
export interface BrowserGatewayOwnerInteractionPayload {
  approval: ApprovalRequest | null;
  question: QuestionRequest | null;
  questionProgress: BrowserGatewayOwnerQuestionProgressPayload | null;
  formElicitation: McpFormElicitationRequest | null;
  urlElicitation: McpUrlElicitationRequest | null;
}

export function projectBrowserGatewayOwnerInteractionPayload(
  value: BrowserGatewayOwnerInteractionPayload,
): BrowserGatewayOwnerInteractionPayload | null {
  try {
    return parseBrowserGatewayOwnerInteractionPayload(value);
  } catch {
    return null;
  }
}

export function parseBrowserGatewayOwnerInteractionPayload(
  value: unknown,
): BrowserGatewayOwnerInteractionPayload {
  const payload = recordValue(value);
  const result: BrowserGatewayOwnerInteractionPayload = {
    approval: nullableValue(payload.approval, approvalRequest),
    question: nullableValue(payload.question, questionRequest),
    questionProgress: nullableValue(payload.questionProgress, questionProgress),
    formElicitation: nullableValue(
      payload.formElicitation,
      formElicitationRequest,
    ),
    urlElicitation: nullableValue(
      payload.urlElicitation,
      urlElicitationRequest,
    ),
  };
  if (
    result.questionProgress &&
    (!result.question ||
      result.questionProgress.id !== result.question.id ||
      !Number.isSafeInteger(result.questionProgress.step) ||
      result.questionProgress.step < 0 ||
      result.questionProgress.step >= result.question.questions.length)
  ) {
    throw new Error("invalid_browser_gateway_interaction_payload");
  }
  return result;
}

function approvalRequest(value: unknown): ApprovalRequest {
  const source = recordValue(value);
  const result: ApprovalRequest = {
    kind: enumValue(source.kind, [
      "command",
      "network",
      "path",
      "write",
      "rename",
      "mcp",
      "mode-switch",
      "memory",
      "worktree",
      "hook",
    ] as const),
    id: stringValue(source.id),
  };
  copyOptional(result, "sourceProject", source.sourceProject, projectContext);
  copyOptional(result, "targetProject", source.targetProject, projectContext);
  copyOptional(result, "targetPath", source.targetPath, stringValue);
  copyOptional(result, "command", source.command, stringValue);
  copyOptional(result, "subCommands", source.subCommands, (item) =>
    arrayValue(item, subCommand),
  );
  copyOptional(result, "inlineFiles", source.inlineFiles, (item) =>
    arrayValue(item, inlineFile),
  );
  copyOptional(result, "filePath", source.filePath, stringValue);
  copyOptional(result, "writeOperation", source.writeOperation, (item) =>
    enumValue(item, ["create", "modify"] as const),
  );
  copyOptional(
    result,
    "outsideWorkspace",
    source.outsideWorkspace,
    booleanValue,
  );
  copyOptional(result, "oldName", source.oldName, stringValue);
  copyOptional(result, "newName", source.newName, stringValue);
  copyOptional(result, "affectedFiles", source.affectedFiles, (item) =>
    arrayValue(item, affectedFile),
  );
  copyOptional(result, "totalChanges", source.totalChanges, finiteNumberValue);
  copyOptional(result, "detail", source.detail, stringValue);
  copyOptional(
    result,
    "queuePosition",
    source.queuePosition,
    finiteNumberValue,
  );
  copyOptional(result, "queueTotal", source.queueTotal, finiteNumberValue);
  copyOptional(result, "reason", source.reason, stringValue);
  copyOptional(result, "cwd", source.cwd, stringValue);
  copyOptional(result, "commandReview", source.commandReview, commandReview);
  copyOptional(result, "humanOnlyReason", source.humanOnlyReason, stringValue);
  copyOptional(
    result,
    "recoveryAttempt",
    source.recoveryAttempt,
    recoveryAttempt,
  );
  copyOptional(result, "security", source.security, terminalSecurity);
  copyOptional(result, "mcpDetail", source.mcpDetail, stringValue);
  copyOptional(result, "mcpServerName", source.mcpServerName, stringValue);
  copyOptional(result, "mcpToolName", source.mcpToolName, stringValue);
  copyOptional(result, "toolOrigin", source.toolOrigin, (item) =>
    enumValue(item, ["mcp", "acp"] as const),
  );
  copyOptional(result, "mcpChoices", source.mcpChoices, (item) =>
    arrayValue(item, approvalChoice),
  );
  copyOptional(result, "hookChoices", source.hookChoices, (item) =>
    arrayValue(item, approvalChoice),
  );
  copyOptional(result, "worktreeChoices", source.worktreeChoices, (item) =>
    arrayValue(item, approvalChoice),
  );
  copyOptional(result, "writeChoices", source.writeChoices, (item) =>
    arrayValue(item, approvalChoice),
  );
  copyOptional(result, "memoryTier", source.memoryTier, (item) =>
    enumValue(item, ["instructions", "skill", "command", "memory"] as const),
  );
  copyOptional(result, "memoryScope", source.memoryScope, (item) =>
    enumValue(item, ["global", "project"] as const),
  );
  copyOptional(result, "memoryOperation", source.memoryOperation, (item) =>
    enumValue(item, ["add", "update", "remove"] as const),
  );
  copyOptional(result, "memoryName", source.memoryName, stringValue);
  copyOptional(result, "memoryTitle", source.memoryTitle, stringValue);
  copyOptional(result, "memoryRationale", source.memoryRationale, stringValue);
  copyOptional(
    result,
    "memoryTargetPath",
    source.memoryTargetPath,
    stringValue,
  );
  copyOptional(result, "memoryContent", source.memoryContent, stringValue);
  return result;
}

function projectContext(value: unknown): ApprovalProjectContext {
  const source = recordValue(value);
  return {
    projectId: stringValue(source.projectId),
    displayName: stringValue(source.displayName),
    availability: enumValue(source.availability, [
      "available",
      "missing",
      "unavailable",
      "invalid",
    ] as const),
  };
}

function subCommand(value: unknown): SubCommandEntry {
  const source = recordValue(value);
  const result: SubCommandEntry = { command: stringValue(source.command) };
  copyOptional(result, "tier", source.tier, (item) => {
    const tier = recordValue(item);
    return {
      tier: enumValue(tier.tier, ["safe", "sensitive", "dangerous"] as const),
      reason: stringValue(tier.reason),
    };
  });
  copyOptional(result, "existingRule", source.existingRule, (item) => {
    const rule = recordValue(item);
    const existingRule: NonNullable<SubCommandEntry["existingRule"]> = {
      pattern: stringValue(rule.pattern),
      mode: enumValue(rule.mode, ["prefix", "exact", "regex"] as const),
      scope: enumValue(rule.scope, ["session", "project", "global"] as const),
    };
    copyOptional(existingRule, "decision", rule.decision, (decision) =>
      enumValue(decision, ["allow", "prompt", "forbidden"] as const),
    );
    return existingRule;
  });
  return result;
}

function inlineFile(value: unknown): InlineCommandFilePreview {
  const source = recordValue(value);
  const result: InlineCommandFilePreview = {
    name: stringValue(source.name),
    path: stringValue(source.path),
    bytes: finiteNumberValue(source.bytes),
    sha256: stringValue(source.sha256),
    truncated: booleanValue(source.truncated),
    executable: booleanValue(source.executable),
    preview: stringValue(source.preview),
  };
  copyOptional(result, "ext", source.ext, stringValue);
  return result;
}

function affectedFile(value: unknown): { path: string; changes: number } {
  const source = recordValue(value);
  return {
    path: stringValue(source.path),
    changes: finiteNumberValue(source.changes),
  };
}

function recoveryAttempt(value: unknown): CommandRecoveryAttempt {
  const source = recordValue(value);
  return {
    denialOperation: stringValue(source.denialOperation),
    denialReason: stringValue(source.denialReason),
    firstAttemptRoute: enumValue(source.firstAttemptRoute, [
      "sandbox",
      "native",
    ] as const),
    commandSent: booleanOrUnknown(source.commandSent),
    processLaunched: booleanOrUnknown(source.processLaunched),
    mayHaveSideEffects: booleanOrUnknown(source.mayHaveSideEffects),
  };
}

function commandReview(value: unknown): CommandReviewSummary {
  const source = recordValue(value);
  return {
    status: enumValue(source.status, [
      "reviewed",
      "unavailable",
      "timed_out",
      "cancelled",
      "invalid",
    ] as const),
    outcome: enumValue(source.outcome, ["allow", "deny"] as const),
    risk: enumValue(source.risk, [
      "low",
      "medium",
      "high",
      "critical",
    ] as const),
    userAuthorization: enumValue(source.userAuthorization, [
      "unknown",
      "low",
      "medium",
      "high",
    ] as const),
    rationale: stringValue(source.rationale),
    model: stringValue(source.model),
  };
}

function terminalSecurity(value: unknown): TerminalExecutionSecuritySummary {
  const source = recordValue(value);
  const result: TerminalExecutionSecuritySummary = {
    auditId: stringValue(source.auditId),
    route: enumValue(source.route, ["sandbox", "native"] as const),
    executionSurface: enumValue(source.executionSurface, [
      "verified-sandbox",
      "agentlink-native",
      "vscode-compatibility",
    ] as const),
    confinement: enumValue(source.confinement, [
      "verified-baseline",
      "native-unsandboxed",
    ] as const),
    routeReason: enumValue(source.routeReason, [
      "verified-local-macos",
      "feature-disabled",
      "unsupported-host",
      "remote-host",
      "runtime-unavailable",
    ] as const),
    approvalPolicySnapshot: enumValue(source.approvalPolicySnapshot, [
      "on-request",
    ] as const),
    approvalReviewerSnapshot: enumValue(source.approvalReviewerSnapshot, [
      "user",
      "auto-review",
    ] as const),
    executionPresetSnapshot: enumValue(source.executionPresetSnapshot, [
      "native-manual",
      "workspace-write",
    ] as const),
    requiredAuthority: enumValue(source.requiredAuthority, [
      "native-agent",
      "sandbox",
    ] as const),
    permissionIntent: enumValue(source.permissionIntent, [
      "default",
      "additional-permissions",
      "native-escalation",
    ] as const),
    approvalRequirement: enumValue(source.approvalRequirement, [
      "policy",
      "explicit-permissions",
      "explicit-escalation",
    ] as const),
    authorityReason: enumValue(source.authorityReason, [
      "approval-policy",
      "additional-permissions",
      "explicit-escalation",
      "explicit-rule",
    ] as const),
    commandApprovalPolicySnapshot: enumValue(
      source.commandApprovalPolicySnapshot,
      ["manual", "safe", "sensitive", "approve-for-me"] as const,
    ),
    executionPolicy: enumValue(source.executionPolicy, [
      "sandbox-baseline-v2",
      "native-legacy-v1",
    ] as const),
    preparedAt: finiteNumberValue(source.preparedAt),
  };
  copyOptional(
    result,
    "commandExecutionPolicySnapshot",
    source.commandExecutionPolicySnapshot,
    (item) => enumValue(item, ["read-only"] as const),
  );
  copyOptional(result, "sandbox", source.sandbox, (item) => {
    const sandbox = recordValue(item);
    return {
      attestationId: stringValue(sandbox.attestationId),
      attestationVersion: stringValue(sandbox.attestationVersion),
      policyVersion: stringValue(sandbox.policyVersion),
      profileId: stringValue(sandbox.profileId),
      backend: enumValue(sandbox.backend, ["seatbelt"] as const),
      architecture: enumValue(sandbox.architecture, ["arm64", "x64"] as const),
      capabilities: sandboxCapabilities(sandbox.capabilities),
    };
  });
  return result;
}

function sandboxCapabilities(
  value: unknown,
): NonNullable<TerminalExecutionSecuritySummary["sandbox"]>["capabilities"] {
  const source = recordValue(value);
  const result: NonNullable<
    TerminalExecutionSecuritySummary["sandbox"]
  >["capabilities"] = {
    backend: stringValue(source.backend),
    processTree: booleanValue(source.processTree),
    filesystemRead: enumValue(source.filesystemRead, [
      "isolated",
      "policy-denied",
      "host-visible",
    ] as const),
    filesystemWrite: enumValue(source.filesystemWrite, [
      "strict",
      "partial",
      "none",
    ] as const),
    network: enumValue(source.network, [
      "blocked",
      "loopback",
      "loopback-listener",
      "proxy-only",
      "partial",
      "unrestricted",
    ] as const),
    privateHome: booleanValue(source.privateHome),
    privateTmp: booleanValue(source.privateTmp),
    hostIpcBlocked: booleanValue(source.hostIpcBlocked),
    resourceLimits: enumValue(source.resourceLimits, [
      "enforced",
      "partial",
      "none",
    ] as const),
    warnings: arrayValue(source.warnings, stringValue),
  };
  copyOptional(result, "backendVersion", source.backendVersion, stringValue);
  return result;
}

function approvalChoice(
  value: unknown,
): NonNullable<ApprovalRequest["mcpChoices"]>[number] {
  const source = recordValue(value);
  const result: NonNullable<ApprovalRequest["mcpChoices"]>[number] = {
    label: stringValue(source.label),
    value: stringValue(source.value),
  };
  copyOptional(result, "isPrimary", source.isPrimary, booleanValue);
  copyOptional(result, "isDanger", source.isDanger, booleanValue);
  return result;
}

function questionRequest(value: unknown): QuestionRequest {
  const source = recordValue(value);
  const result: QuestionRequest = {
    id: stringValue(source.id),
    context: stringValue(source.context),
    questions: arrayValue(source.questions, question),
  };
  copyOptional(result, "backgroundTask", source.backgroundTask, stringValue);
  return result;
}

function question(value: unknown): Question {
  const source = recordValue(value);
  const result: Question = {
    id: stringValue(source.id),
    type: enumValue(source.type, [
      "multiple_choice",
      "multiple_select",
      "yes_no",
      "text",
      "scale",
      "confirmation",
    ] as const),
    question: stringValue(source.question),
  };
  copyOptional(result, "context", source.context, stringValue);
  copyOptional(result, "options", source.options, (item) =>
    arrayValue(item, stringValue),
  );
  copyOptional(result, "recommended", source.recommended, stringValue);
  copyOptional(result, "allowBlank", source.allowBlank, booleanValue);
  copyOptional(result, "scale_min", source.scale_min, finiteNumberValue);
  copyOptional(result, "scale_max", source.scale_max, finiteNumberValue);
  copyOptional(result, "scale_min_label", source.scale_min_label, stringValue);
  copyOptional(result, "scale_max_label", source.scale_max_label, stringValue);
  copyOptional(result, "modeSwitch", source.modeSwitch, stringRecord);
  return result;
}

function questionProgress(
  value: unknown,
): BrowserGatewayOwnerQuestionProgressPayload {
  const source = recordValue(value);
  const answers: BrowserGatewayOwnerQuestionProgressPayload["answers"] = {};
  for (const [key, answer] of Object.entries(recordValue(source.answers))) {
    if (answer === undefined) continue;
    if (
      typeof answer === "string" ||
      typeof answer === "boolean" ||
      (typeof answer === "number" && Number.isFinite(answer))
    ) {
      answers[key] = answer;
      continue;
    }
    if (Array.isArray(answer)) {
      answers[key] = arrayValue(answer, stringValue);
      continue;
    }
    throw new Error("invalid_browser_gateway_interaction_payload");
  }
  return {
    id: stringValue(source.id),
    step: finiteNumberValue(source.step),
    answers,
    notes: stringRecord(source.notes),
    origin: stringValue(source.origin),
  };
}

function formElicitationRequest(value: unknown): McpFormElicitationRequest {
  const source = recordValue(value);
  return {
    id: stringValue(source.id),
    serverName: stringValue(source.serverName),
    message: stringValue(source.message),
    fields: arrayValue(source.fields, elicitationField),
  };
}

function elicitationField(value: unknown): McpElicitationField {
  const source = recordValue(value);
  const common = {
    name: stringValue(source.name),
    required: booleanValue(source.required),
  };
  copyOptional(common, "title", source.title, stringValue);
  copyOptional(common, "description", source.description, stringValue);
  const kind = enumValue(source.kind, [
    "string",
    "number",
    "integer",
    "boolean",
    "single-select",
    "multi-select",
  ] as const);
  switch (kind) {
    case "string": {
      const result: Extract<McpElicitationField, { kind: "string" }> = {
        ...common,
        kind,
      };
      copyOptional(result, "default", source.default, stringValue);
      copyOptional(result, "format", source.format, (item) =>
        enumValue(item, ["email", "uri", "date", "date-time"] as const),
      );
      copyOptional(result, "minLength", source.minLength, finiteNumberValue);
      copyOptional(result, "maxLength", source.maxLength, finiteNumberValue);
      return result;
    }
    case "number":
    case "integer": {
      const result: Extract<McpElicitationField, { kind: typeof kind }> = {
        ...common,
        kind,
      };
      copyOptional(result, "default", source.default, finiteNumberValue);
      copyOptional(result, "minimum", source.minimum, finiteNumberValue);
      copyOptional(result, "maximum", source.maximum, finiteNumberValue);
      return result;
    }
    case "boolean": {
      const result: Extract<McpElicitationField, { kind: "boolean" }> = {
        ...common,
        kind,
      };
      copyOptional(result, "default", source.default, booleanValue);
      return result;
    }
    case "single-select": {
      const result: Extract<McpElicitationField, { kind: "single-select" }> = {
        ...common,
        kind,
        options: arrayValue(source.options, elicitationOption),
      };
      copyOptional(result, "default", source.default, stringValue);
      return result;
    }
    case "multi-select": {
      const result: Extract<McpElicitationField, { kind: "multi-select" }> = {
        ...common,
        kind,
        options: arrayValue(source.options, elicitationOption),
      };
      copyOptional(result, "default", source.default, (item) =>
        arrayValue(item, stringValue),
      );
      copyOptional(result, "minItems", source.minItems, finiteNumberValue);
      copyOptional(result, "maxItems", source.maxItems, finiteNumberValue);
      return result;
    }
  }
}

function elicitationOption(value: unknown): McpElicitationOption {
  const source = recordValue(value);
  const result: McpElicitationOption = { value: stringValue(source.value) };
  copyOptional(result, "title", source.title, stringValue);
  return result;
}

function urlElicitationRequest(value: unknown): McpUrlElicitationRequest {
  const source = recordValue(value);
  return {
    id: stringValue(source.id),
    serverName: stringValue(source.serverName),
    message: stringValue(source.message),
    url: stringValue(source.url),
    elicitationId: stringValue(source.elicitationId),
    origin: stringValue(source.origin),
    host: stringValue(source.host),
    isLocalAddress: booleanValue(source.isLocalAddress),
  };
}

function nullableValue<T>(
  value: unknown,
  parse: (candidate: unknown) => T,
): T | null {
  if (value === null) return null;
  if (value === undefined) {
    throw new Error("invalid_browser_gateway_interaction_payload");
  }
  return parse(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_browser_gateway_interaction_payload");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("invalid_browser_gateway_interaction_payload");
  }
  return value;
}

function booleanOrUnknown(value: unknown): boolean | "unknown" {
  return value === "unknown" ? value : booleanValue(value);
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("invalid_browser_gateway_interaction_payload");
  }
  return value;
}

function finiteNumberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("invalid_browser_gateway_interaction_payload");
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error("invalid_browser_gateway_interaction_payload");
  }
  return value;
}

function arrayValue<T>(value: unknown, parse: (candidate: unknown) => T): T[] {
  if (!Array.isArray(value)) {
    throw new Error("invalid_browser_gateway_interaction_payload");
  }
  return value.map(parse);
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(recordValue(value)).map(([key, entry]) => [
      key,
      stringValue(entry),
    ]),
  );
}

function copyOptional<T extends object>(
  target: T,
  key: string,
  value: unknown,
  parse: (candidate: unknown) => unknown,
): void {
  if (value === undefined) return;
  (target as Record<string, unknown>)[key] = parse(value);
}
