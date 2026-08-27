export const HOOK_EVENT_NAMES = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];
export type HookHandlerType = "command" | "mcp_tool" | "prompt" | "agent";
export type HookDiagnosticSeverity = "warning" | "error";

export interface HookDiagnostic {
  readonly code: string;
  readonly severity: HookDiagnosticSeverity;
  readonly message: string;
  readonly sourceId?: string;
  readonly event?: HookEventName;
  readonly jsonPath?: string;
  readonly handlerKey?: string;
}

export interface HookPluginContext {
  readonly root: string;
  readonly data: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly replacements?: Readonly<Record<string, string>>;
}

/** An explicit hooks.json input. Resolution and precedence belong to the caller. */
export interface HookSourceDefinition {
  readonly id: string;
  readonly content: string;
  readonly kind?: "configuration" | "plugin";
  readonly reviewed?: boolean;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly replacements?: Readonly<Record<string, string>>;
  readonly plugin?: HookPluginContext;
}

export interface HookSource {
  readonly id: string;
  readonly kind: "configuration" | "plugin";
  readonly reviewed: boolean;
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly replacements: Readonly<Record<string, string>>;
  readonly plugin?: HookPluginContext;
}

export interface CommandHookHandler {
  readonly type: "command";
  readonly command: string;
  readonly commandWindows?: string;
  readonly timeoutSeconds?: number;
  readonly async: boolean;
}

export interface UnsupportedHookHandler {
  readonly type: "mcp_tool" | "prompt" | "agent";
  readonly configuration: Readonly<Record<string, unknown>>;
}

export type HookHandler = CommandHookHandler | UnsupportedHookHandler;

export interface HookMatcher {
  readonly sourceText?: string;
  readonly ignored: boolean;
  test(value: string | undefined): boolean;
}

export interface RegisteredHookHandler {
  readonly event: HookEventName;
  readonly matcher: HookMatcher;
  readonly handler: HookHandler;
  readonly source: HookSource;
  readonly declarationIndex: number;
  /** Stable identity including source, event, matcher, and declaration location. */
  readonly key: string;
  /** Stable identity of the executable handler configuration. */
  readonly hash: string;
}

export interface HookConfiguration {
  readonly handlers: readonly RegisteredHookHandler[];
  readonly diagnostics: readonly HookDiagnostic[];
}

export type HookInput = Readonly<Record<string, unknown>>;

export interface HookTrustRequest {
  readonly key: string;
  readonly hash: string;
  readonly event: HookEventName;
  readonly command: string;
  readonly sourceId: string;
  readonly sourceKind: HookSource["kind"];
  readonly sourceReviewed: boolean;
}

export type HookTrustCallback = (
  request: Readonly<HookTrustRequest>,
) => boolean | Promise<boolean>;

export interface HookProcessRequest {
  readonly command: string;
  readonly input: HookInput;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly replacements?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface HookProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly outputLimitExceeded: boolean;
  readonly durationMs: number;
}

export type HookProcessRunner = (
  request: Readonly<HookProcessRequest>,
) => Promise<HookProcessResult>;

export interface HookHandlerOutput {
  readonly handlerKey: string;
  readonly handlerHash: string;
  readonly declarationIndex: number;
  readonly completionIndex: number;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly value?: Readonly<Record<string, unknown>>;
  readonly plainText?: string;
}

export interface PreToolUseEffect {
  readonly decision?: "allow" | "ask" | "deny";
  readonly reason?: string;
  readonly updatedInput?: unknown;
  readonly additionalContext?: string;
}

export interface HookBlockEffect {
  readonly blocked: true;
  readonly reason?: string;
}

export interface PermissionRequestEffect {
  readonly decision: "allow" | "ask" | "deny";
  readonly reason?: string;
}

export interface StopEffect {
  /** true asks the agent to continue; false ends the current run. */
  readonly continue: boolean;
  readonly reason?: string;
}

export interface HookDispatchResult {
  readonly event: HookEventName;
  /** Completed synchronous outputs in source/declaration order. */
  readonly outputs: readonly HookHandlerOutput[];
  readonly diagnostics: readonly HookDiagnostic[];
  readonly additionalContext: readonly string[];
  readonly feedback: readonly string[];
  /** Blocking result for UserPromptSubmit, PostToolUse, or PreCompact. */
  readonly block?: HookBlockEffect;
  readonly preToolUse?: PreToolUseEffect;
  readonly permissionRequest?: PermissionRequestEffect;
  readonly stop?: StopEffect;
  readonly asyncScheduled: number;
}

export interface HookDispatchRequest {
  readonly event: HookEventName;
  readonly input: HookInput;
  /** Usually a tool name. Ignored for events whose compatibility format has no matcher. */
  readonly matcherValue?: string;
  /** Compatibility aliases tested in addition to matcherValue; each handler still runs once. */
  readonly matcherAliases?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface HookRuntimeOptions {
  readonly configuration: HookConfiguration;
  readonly trust: HookTrustCallback;
  readonly processRunner?: HookProcessRunner;
  readonly defaultTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxAsyncHandlers?: number;
  readonly onDiagnostic?: (diagnostic: HookDiagnostic) => void;
  readonly onAsyncOutput?: (
    event: HookEventName,
    output: HookHandlerOutput,
  ) => void;
}
