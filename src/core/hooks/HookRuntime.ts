import type {
  HookBlockEffect,
  HookDiagnostic,
  HookDispatchRequest,
  HookDispatchResult,
  HookEventName,
  HookHandlerOutput,
  HookInput,
  HookRuntimeOptions,
  PermissionRequestEffect,
  PreToolUseEffect,
  RegisteredHookHandler,
  StopEffect,
} from "./contracts";

import { runHookProcess } from "./hookProcessRunner";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_ASYNC_HANDLERS = 8;

export class HookRuntime {
  private readonly options: HookRuntimeOptions;
  private readonly asyncLimit: number;
  private asyncActive = 0;
  private readonly asyncQueue: Array<() => void> = [];

  constructor(options: HookRuntimeOptions) {
    this.options = options;
    this.asyncLimit = Math.min(
      DEFAULT_MAX_ASYNC_HANDLERS,
      positiveInteger(options.maxAsyncHandlers, DEFAULT_MAX_ASYNC_HANDLERS),
    );
  }

  async dispatch(
    request: Readonly<HookDispatchRequest>,
  ): Promise<HookDispatchResult> {
    const diagnostics: HookDiagnostic[] = [];
    const synchronous: RegisteredHookHandler[] = [];
    let asyncScheduled = 0;

    for (const registered of this.options.configuration.handlers) {
      if (registered.event !== request.event) continue;
      let matches = false;
      try {
        matches = [
          request.matcherValue,
          ...(request.matcherAliases ?? []),
        ].some((candidate) => registered.matcher.test(candidate));
      } catch (error) {
        this.addDiagnostic(diagnostics, {
          code: "hook_matcher_failed",
          severity: "error",
          message: `Hook matcher failed open: ${errorMessage(error)}`,
          sourceId: registered.source.id,
          event: request.event,
          handlerKey: registered.key,
        });
      }
      if (!matches || registered.handler.type !== "command") continue;

      const shouldRunAsync =
        registered.handler.async && request.event !== "SessionEnd";
      if (shouldRunAsync) {
        asyncScheduled += 1;
        void this.scheduleAsync(async () => {
          const output = await this.executeHandler(registered, request, []);
          if (output) this.options.onAsyncOutput?.(request.event, output);
        });
      } else {
        synchronous.push(registered);
      }
    }

    let completionIndex = 0;
    const completed = await Promise.all(
      synchronous.map(async (registered) => {
        const output = await this.executeHandler(
          registered,
          request,
          diagnostics,
        );
        const completedAt = completionIndex;
        completionIndex += 1;
        return output ? { ...output, completionIndex: completedAt } : undefined;
      }),
    );
    const outputs = completed
      .filter((output): output is HookHandlerOutput => output !== undefined)
      .sort((left, right) => left.declarationIndex - right.declarationIndex);

    return interpretOutputs(
      request.event,
      outputs,
      diagnostics,
      asyncScheduled,
    );
  }

  dispatchEvent(
    event: HookEventName,
    input: HookInput,
    options: Readonly<{ matcherValue?: string; signal?: AbortSignal }> = {},
  ): Promise<HookDispatchResult> {
    return this.dispatch({ event, input, ...options });
  }

  sessionStart(
    input: HookInput,
    signal?: AbortSignal,
  ): Promise<HookDispatchResult> {
    return this.dispatch({
      event: "SessionStart",
      input,
      matcherValue: stringValue(input.source),
      signal,
    });
  }

  userPromptSubmit(
    input: HookInput,
    signal?: AbortSignal,
  ): Promise<HookDispatchResult> {
    return this.dispatch({ event: "UserPromptSubmit", input, signal });
  }

  preToolUse(
    input: HookInput,
    toolName: string,
    signal?: AbortSignal,
    matcherAliases?: readonly string[],
  ): Promise<HookDispatchResult> {
    return this.dispatch({
      event: "PreToolUse",
      input,
      matcherValue: toolName,
      matcherAliases,
      signal,
    });
  }

  postToolUse(
    input: HookInput,
    toolName: string,
    signal?: AbortSignal,
    matcherAliases?: readonly string[],
  ): Promise<HookDispatchResult> {
    return this.dispatch({
      event: "PostToolUse",
      input,
      matcherValue: toolName,
      matcherAliases,
      signal,
    });
  }

  preCompact(
    input: HookInput,
    signal?: AbortSignal,
  ): Promise<HookDispatchResult> {
    return this.dispatch({
      event: "PreCompact",
      input,
      matcherValue: stringValue(input.trigger),
      signal,
    });
  }

  postCompact(
    input: HookInput,
    signal?: AbortSignal,
  ): Promise<HookDispatchResult> {
    return this.dispatch({
      event: "PostCompact",
      input,
      matcherValue: stringValue(input.trigger),
      signal,
    });
  }

  stop(input: HookInput, signal?: AbortSignal): Promise<HookDispatchResult> {
    return this.dispatch({ event: "Stop", input, signal });
  }

  sessionEnd(
    input: HookInput,
    signal?: AbortSignal,
  ): Promise<HookDispatchResult> {
    return this.dispatch({
      event: "SessionEnd",
      input,
      matcherValue: stringValue(input.reason),
      signal,
    });
  }

  interrupt(
    input: HookInput,
    signal?: AbortSignal,
  ): Promise<HookDispatchResult> {
    return this.dispatch({ event: "Interrupt", input, signal });
  }

  private async executeHandler(
    registered: RegisteredHookHandler,
    request: Readonly<HookDispatchRequest>,
    diagnostics: HookDiagnostic[],
  ): Promise<HookHandlerOutput | undefined> {
    if (registered.handler.type !== "command") return undefined;
    try {
      const trusted = await this.options.trust({
        key: registered.key,
        hash: registered.hash,
        event: registered.event,
        command: registered.handler.command,
        sourceId: registered.source.id,
        sourceKind: registered.source.kind,
        sourceReviewed: registered.source.reviewed,
      });
      if (!trusted) {
        this.addDiagnostic(diagnostics, {
          code: "hook_handler_untrusted",
          severity: "warning",
          message: "Untrusted hook handler was skipped.",
          sourceId: registered.source.id,
          event: registered.event,
          handlerKey: registered.key,
        });
        return undefined;
      }
    } catch (error) {
      this.addDiagnostic(diagnostics, {
        code: "hook_trust_failed",
        severity: "error",
        message: `Hook trust check failed open: ${errorMessage(error)}`,
        sourceId: registered.source.id,
        event: registered.event,
        handlerKey: registered.key,
      });
      return undefined;
    }

    try {
      const handler = registered.handler;
      const result = await (this.options.processRunner ?? runHookProcess)({
        command:
          process.platform === "win32" && handler.commandWindows
            ? handler.commandWindows
            : handler.command,
        input: request.input,
        cwd: registered.source.cwd,
        env: registered.source.env,
        replacements: registered.source.replacements,
        timeoutMs: normalizeTimeoutMs(
          registered.event,
          handler.timeoutSeconds,
          this.options.defaultTimeoutMs,
        ),
        maxOutputBytes: positiveInteger(
          this.options.maxOutputBytes,
          DEFAULT_MAX_OUTPUT_BYTES,
        ),
        signal: request.signal,
      });
      if (result.timedOut || result.aborted || result.outputLimitExceeded) {
        this.addDiagnostic(diagnostics, {
          code: result.timedOut
            ? "hook_handler_timeout"
            : result.aborted
              ? "hook_handler_aborted"
              : "hook_handler_output_limit",
          severity: "error",
          message: result.timedOut
            ? "Hook handler timed out; execution failed open."
            : result.aborted
              ? "Hook handler was aborted; execution failed open."
              : "Hook handler exceeded its output limit; execution failed open.",
          sourceId: registered.source.id,
          event: registered.event,
          handlerKey: registered.key,
        });
        return undefined;
      }
      const exitTwoControlsEvent =
        result.exitCode === 2 &&
        (registered.event === "PreToolUse" ||
          registered.event === "PermissionRequest" ||
          registered.event === "PostToolUse" ||
          registered.event === "UserPromptSubmit" ||
          registered.event === "Stop" ||
          registered.event === "SubagentStop");
      if (result.exitCode !== 0 && !exitTwoControlsEvent) {
        this.addDiagnostic(diagnostics, {
          code: "hook_handler_nonzero_exit",
          severity: "error",
          message: `Hook handler exited with code ${result.exitCode ?? "unknown"}; execution failed open.`,
          sourceId: registered.source.id,
          event: registered.event,
          handlerKey: registered.key,
        });
        return undefined;
      }
      const parsed = parseOutput(result.stdout);
      if (parsed.diagnostic) {
        this.addDiagnostic(diagnostics, {
          ...parsed.diagnostic,
          sourceId: registered.source.id,
          event: registered.event,
          handlerKey: registered.key,
        });
      }
      return {
        handlerKey: registered.key,
        handlerHash: registered.hash,
        declarationIndex: registered.declarationIndex,
        completionIndex: 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(parsed.value ? { value: parsed.value } : {}),
        ...(parsed.plainText ? { plainText: parsed.plainText } : {}),
      };
    } catch (error) {
      this.addDiagnostic(diagnostics, {
        code: "hook_handler_failed",
        severity: "error",
        message: `Hook handler failed open: ${errorMessage(error)}`,
        sourceId: registered.source.id,
        event: registered.event,
        handlerKey: registered.key,
      });
      return undefined;
    }
  }

  private async scheduleAsync(task: () => Promise<void>): Promise<void> {
    if (this.asyncActive >= this.asyncLimit) {
      await new Promise<void>((resolve) => this.asyncQueue.push(resolve));
    }
    this.asyncActive += 1;
    try {
      await task();
    } finally {
      this.asyncActive -= 1;
      this.asyncQueue.shift()?.();
    }
  }

  private addDiagnostic(
    target: HookDiagnostic[],
    diagnostic: HookDiagnostic,
  ): void {
    target.push(diagnostic);
    this.options.onDiagnostic?.(diagnostic);
  }
}

function interpretOutputs(
  event: HookEventName,
  outputs: readonly HookHandlerOutput[],
  diagnostics: readonly HookDiagnostic[],
  asyncScheduled: number,
): HookDispatchResult {
  const additionalContext: string[] = [];
  const feedback: string[] = [];
  let block: HookBlockEffect | undefined;
  let preToolUse: PreToolUseEffect | undefined;
  let permissionRequest: PermissionRequestEffect | undefined;
  let stop: StopEffect | undefined;

  for (const output of outputs) {
    const value = output.value;
    const specific = isRecord(value?.hookSpecificOutput)
      ? value.hookSpecificOutput
      : value;
    const context = stringValue(specific?.additionalContext);
    const reason = stringValue(
      specific?.permissionDecisionReason ?? value?.reason ?? value?.stopReason,
    );
    const feedbackText = stringValue(specific?.feedback);
    const plain = output.plainText?.trim();

    if (
      context &&
      (event === "SessionStart" ||
        event === "UserPromptSubmit" ||
        event === "PreToolUse" ||
        event === "PostToolUse")
    ) {
      additionalContext.push(context);
    } else if (
      plain &&
      (event === "SessionStart" || event === "UserPromptSubmit")
    ) {
      additionalContext.push(plain);
    }

    if (event === "PostToolUse" && feedbackText) {
      feedback.push(feedbackText);
    }

    if (
      (event === "SessionStart" ||
        event === "UserPromptSubmit" ||
        event === "PostToolUse" ||
        event === "PostCompact") &&
      (value?.continue === false ||
        stringValue(value?.decision) === "block" ||
        output.exitCode === 2)
    ) {
      block = {
        blocked: true,
        ...(reason
          ? { reason }
          : output.stderr.trim()
            ? { reason: output.stderr.trim() }
            : {}),
      };
    }

    if (event === "Stop") {
      const continueValue = value?.continue;
      const decision = stringValue(value?.decision);
      if (continueValue === false) {
        stop = { continue: false, ...(reason ? { reason } : {}) };
      } else if (decision === "block" || output.exitCode === 2) {
        stop = {
          continue: true,
          ...(reason
            ? { reason }
            : output.stderr.trim()
              ? { reason: output.stderr.trim() }
              : {}),
        };
      }
    }
  }

  if (event === "PreToolUse") {
    for (const output of [...outputs].sort(
      (left, right) => left.completionIndex - right.completionIndex,
    )) {
      const value = output.value;
      const specific = isRecord(value?.hookSpecificOutput)
        ? value.hookSpecificOutput
        : value;
      const legacyDecision = stringValue(value?.decision);
      const decision =
        legacyDecision === "block"
          ? "deny"
          : permissionDecision(specific?.permissionDecision);
      const deniedByExit = output.exitCode === 2;
      const reason = stringValue(
        specific?.permissionDecisionReason ?? value?.reason,
      );
      const context = stringValue(specific?.additionalContext);
      const next: PreToolUseEffect = {
        ...(deniedByExit ? { decision: "deny" } : decision ? { decision } : {}),
        ...(reason
          ? { reason }
          : deniedByExit && output.stderr
            ? { reason: output.stderr.trim() }
            : {}),
        ...(specific && "updatedInput" in specific
          ? { updatedInput: specific.updatedInput }
          : {}),
        ...(context ? { additionalContext: context } : {}),
      };
      if (Object.keys(next).length > 0) {
        preToolUse =
          preToolUse?.decision === "deny" && next.decision !== "deny"
            ? preToolUse
            : next;
      }
    }
  }

  if (event === "PermissionRequest") {
    for (const output of outputs) {
      const value = output.value;
      const specific = isRecord(value?.hookSpecificOutput)
        ? value.hookSpecificOutput
        : value;
      const decision =
        output.exitCode === 2
          ? "deny"
          : permissionDecision(
              specific?.decision ?? specific?.permissionDecision,
            );
      if (!decision) continue;
      const reason =
        stringValue(specific?.reason ?? specific?.permissionDecisionReason) ??
        (output.exitCode === 2 ? output.stderr.trim() || undefined : undefined);
      const next: PermissionRequestEffect = {
        decision,
        ...(reason ? { reason } : {}),
      };
      permissionRequest =
        permissionRequest?.decision === "deny" && decision !== "deny"
          ? permissionRequest
          : next;
    }
  }

  return {
    event,
    outputs,
    diagnostics,
    additionalContext,
    feedback,
    ...(block ? { block } : {}),
    ...(preToolUse ? { preToolUse } : {}),
    ...(permissionRequest ? { permissionRequest } : {}),
    ...(stop ? { stop } : {}),
    asyncScheduled,
  };
}

function parseOutput(stdout: string): {
  value?: Readonly<Record<string, unknown>>;
  plainText?: string;
  diagnostic?: Omit<HookDiagnostic, "sourceId" | "event" | "handlerKey">;
} {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    const value: unknown = JSON.parse(trimmed);
    if (isRecord(value)) return { value };
    return {
      plainText: trimmed,
      diagnostic: {
        code: "hook_output_json_not_object",
        severity: "warning",
        message:
          "Hook JSON output was not an object and was treated as plain text.",
      },
    };
  } catch {
    return { plainText: trimmed };
  }
}

function permissionDecision(
  value: unknown,
): "allow" | "ask" | "deny" | undefined {
  return value === "allow" || value === "ask" || value === "deny"
    ? value
    : undefined;
}

function normalizeTimeoutMs(
  event: HookEventName,
  timeoutSeconds: number | undefined,
  configuredDefaultMs: number | undefined,
): number {
  if (event === "SessionEnd" || event === "Interrupt") {
    const requested = timeoutSeconds ?? 1;
    return Math.min(3, Math.max(1, Math.floor(requested))) * 1_000;
  }
  return timeoutSeconds !== undefined
    ? Math.max(1, Math.floor(timeoutSeconds)) * 1_000
    : positiveInteger(configuredDefaultMs, DEFAULT_TIMEOUT_MS);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? (value as number)
    : fallback;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
