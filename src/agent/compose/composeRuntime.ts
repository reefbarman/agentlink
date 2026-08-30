import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import asyncifyVariant from "@jitl/quickjs-wasmfile-release-asyncify";
import {
  DefaultIntrinsics,
  isFail,
  newQuickJSAsyncWASMModuleFromVariant,
  newVariant,
  type QuickJSAsyncContext,
  type QuickJSAsyncRuntime,
  type QuickJSHandle,
} from "quickjs-emscripten-core";

import type {
  ComposeTrace,
  ComposeTraceChild,
} from "@agentlink/protocol/compose";
import type { ToolResult } from "@agentlink/protocol/tool-result";
import type { ComposeExecutionScope } from "./composeScope.js";

export const COMPOSE_MAX_CHILD_CALLS = 64;
export const COMPOSE_MAX_BATCH_SIZE = 16;
export const COMPOSE_MAX_CONCURRENCY = 4;
export const COMPOSE_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
export const COMPOSE_TIMEOUT_MS = 60_000;
export const COMPOSE_MAX_SCRIPT_BYTES = 64 * 1024;
export const COMPOSE_MAX_CHILD_BYTES = 1024 * 1024;
export const COMPOSE_MAX_CUMULATIVE_CHILD_BYTES = 8 * 1024 * 1024;
export const COMPOSE_MAX_FINAL_BYTES = 40 * 1024;
export const COMPOSE_MAX_RECOVERY_PREVIEW_BYTES = 8 * 1024;
export const COMPOSE_MAX_RECOVERY_CHILDREN = 16;
export const COMPOSE_MAX_TRACE_BYTES = 32 * 1024;
export const COMPOSE_MAX_ARTIFACT_RECORD_BYTES = 8 * 1024;
export const COMPOSE_MAX_ARTIFACT_INPUT_BYTES = 10 * 1024 * 1024;
export const COMPOSE_ARTIFACT_TIMEOUT_MS = 2_000;

const COMPOSE_FILENAME = "compose-script.js";
const COMPOSE_MAX_DESCRIPTION_BYTES = 1024;
const COMPOSE_MAX_TRACE_MESSAGE_CHARS = 512;
const COMPOSE_MAX_INPUT_SUMMARY_CHARS = 256;
const COMPOSE_MAX_STACK_CHARS = 2048;
const encoder = new TextEncoder();

export interface ComposeParams {
  script: string;
  description?: string;
}

export interface ComposeArtifactWriteRequest {
  content: string;
  extension: "jsonl";
  signal: AbortSignal;
}

export interface ComposeArtifactWriteResult {
  path: string;
  bytes: number;
  chars: number;
  sha256: string;
}

export interface ComposeRuntimeOptions {
  params: ComposeParams;
  scope: ComposeExecutionScope;
  signal: AbortSignal;
  wasmPath: string;
  retainArtifact?: (
    request: ComposeArtifactWriteRequest,
  ) => Promise<ComposeArtifactWriteResult | null>;
}

export type ComposeErrorKind =
  | "aborted"
  | "budget_exhausted"
  | "child_failed"
  | "internal"
  | "memory_limit"
  | "policy"
  | "script_error"
  | "serialization"
  | "timeout"
  | "validation";

export type ComposeToolResult = ToolResult & {
  uiMeta: NonNullable<ToolResult["uiMeta"]> & {
    composeTrace: ComposeTrace;
  };
};

interface ComposeToolDescriptor {
  name: string;
  input: Record<string, unknown>;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface ComposeRuntimeState {
  callCount: number;
  cumulativeChildBytes: number;
  toolAllBatchCount: number;
  toolAllSettledBatchCount: number;
  nextTraceId: number;
  trace: ComposeTrace;
  bridgeActive: boolean;
  abortController: AbortController;
}

class ComposeRuntimeError extends Error {
  constructor(
    readonly kind: ComposeErrorKind,
    message: string,
    readonly stackDetail?: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ComposeRuntimeError";
  }
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const truncated = value.slice(0, low);
  const trailingCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return trailingCodeUnit >= 0xd800 && trailingCodeUnit <= 0xdbff
    ? truncated.slice(0, -1)
    : truncated;
}

function serializeJson(value: unknown, subject: string): string {
  const ancestors = new Set<object>();
  const normalize = (current: unknown): JsonValue => {
    if (
      typeof current === "undefined" ||
      typeof current === "function" ||
      typeof current === "symbol" ||
      typeof current === "bigint"
    ) {
      throw new ComposeRuntimeError(
        "serialization",
        `${subject} contains unsupported ${typeof current} data`,
      );
    }
    if (typeof current === "number" && !Number.isFinite(current)) {
      throw new ComposeRuntimeError(
        "serialization",
        `${subject} contains a non-finite number`,
      );
    }
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "number" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    const object = current as object;
    if (ancestors.has(object)) {
      throw new ComposeRuntimeError(
        "serialization",
        `${subject} contains cyclic data`,
      );
    }
    ancestors.add(object);
    try {
      if (Array.isArray(current)) return current.map(normalize);
      const output: { [key: string]: JsonValue } = {};
      for (const [key, child] of Object.entries(current as object)) {
        output[key] = normalize(child);
      }
      return output;
    } finally {
      ancestors.delete(object);
    }
  };

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(normalize(value));
  } catch (error) {
    if (error instanceof ComposeRuntimeError) throw error;
    throw new ComposeRuntimeError(
      "serialization",
      `${subject} is not JSON-serializable: ${errorMessage(error)}`,
    );
  }
  if (serialized === undefined) {
    throw new ComposeRuntimeError(
      "serialization",
      `${subject} must be a JSON-compatible value`,
    );
  }
  return serialized;
}

function parseJson(serialized: string, subject: string): JsonValue {
  try {
    return JSON.parse(serialized) as JsonValue;
  } catch (error) {
    throw new ComposeRuntimeError(
      "serialization",
      `${subject} was not valid JSON: ${errorMessage(error)}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyError(error: unknown): ComposeRuntimeError {
  if (error instanceof ComposeRuntimeError) return error;
  const scopedKind =
    typeof error === "object" && error !== null && "kind" in error
      ? String(error.kind)
      : undefined;
  const scopedCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String(error.name)
      : "Error";
  const message = errorMessage(error);
  const stack =
    typeof error === "object" &&
    error !== null &&
    "stack" in error &&
    typeof error.stack === "string"
      ? truncate(error.stack, COMPOSE_MAX_STACK_CHARS)
      : undefined;
  const kindText = `${name} ${message}`.toLowerCase();

  if (
    scopedKind === "aborted" ||
    name === "AbortError" ||
    kindText.includes("abort")
  ) {
    return new ComposeRuntimeError("aborted", "Compose execution was aborted");
  }
  if (scopedKind === "budget_exhausted") {
    return new ComposeRuntimeError(
      "budget_exhausted",
      message,
      stack,
      scopedCode,
    );
  }
  if (
    scopedKind === "authorization" ||
    scopedKind === "recursive_compose" ||
    scopedKind === "tool_input_not_composable" ||
    scopedKind === "tool_not_composable"
  ) {
    return new ComposeRuntimeError("policy", message, stack, scopedCode);
  }
  if (
    kindText.includes("memory") ||
    kindText.includes("out of memory") ||
    kindText.includes("allocation")
  ) {
    return new ComposeRuntimeError(
      "memory_limit",
      `Compose exceeded the ${COMPOSE_MEMORY_LIMIT_BYTES / 1024 / 1024} MiB memory limit`,
      stack,
    );
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    (error.kind === "child_handler_failed" ||
      error.kind === "canonical_result_required")
  ) {
    return new ComposeRuntimeError("child_failed", message, stack, scopedCode);
  }
  return new ComposeRuntimeError("internal", message, stack, scopedCode);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ComposeRuntimeError("aborted", "Compose execution was aborted");
  }
}

async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  assertNotAborted(signal);
  let rejectAbort!: (error: ComposeRuntimeError) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () =>
    rejectAbort(
      new ComposeRuntimeError("aborted", "Compose execution was aborted"),
    );
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function assertRecord(
  value: unknown,
  subject: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ComposeRuntimeError("validation", `${subject} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateDescriptor(
  value: unknown,
  subject: string,
): ComposeToolDescriptor {
  const descriptor = assertRecord(value, subject);
  if (typeof descriptor.name !== "string" || descriptor.name.length === 0) {
    throw new ComposeRuntimeError(
      "validation",
      `${subject}.name must be a non-empty string`,
    );
  }
  return {
    name: descriptor.name,
    input: assertRecord(descriptor.input, `${subject}.input`),
  };
}

function summarizeInput(input: Record<string, unknown>): string {
  try {
    return truncate(
      serializeJson(input, "Child input"),
      COMPOSE_MAX_INPUT_SUMMARY_CHARS,
    );
  } catch {
    return "[unserializable input]";
  }
}

function appendTrace(trace: ComposeTrace, child: ComposeTraceChild): void {
  trace.totalChildren += 1;
  trace.completedChildren += 1;
  if (child.status === "completed") {
    trace.succeededChildren = (trace.succeededChildren ?? 0) + 1;
  } else if (child.status === "cancelled") {
    trace.cancelledChildren = (trace.cancelledChildren ?? 0) + 1;
  } else {
    trace.failedChildren = (trace.failedChildren ?? 0) + 1;
  }
  const next = [...trace.children, child];
  if (
    byteLength(JSON.stringify({ ...trace, children: next })) <=
    COMPOSE_MAX_TRACE_BYTES
  ) {
    trace.children = next;
  }
}

function createResult(
  data: unknown,
  trace: ComposeTrace,
  error?: ComposeRuntimeError,
): ComposeToolResult {
  const payload = error
    ? {
        error: error.message,
        kind: error.kind,
        ...(error.code ? { code: error.code } : {}),
        ...(error.stackDetail ? { stack: error.stackDetail } : {}),
      }
    : data;
  trace.status =
    error?.kind === "aborted" ? "cancelled" : error ? "error" : "completed";
  if (error) trace.errorKind = error.kind;
  else delete trace.errorKind;
  return {
    data: payload,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: Boolean(error),
    ...(error
      ? { error: { kind: error.kind, message: error.message } }
      : undefined),
    uiMeta: { composeTrace: trace },
  };
}

interface ComposeOversizedArtifactRecovery {
  output_file: string;
  output_format: "chunked-json-v1";
  output_bytes: number;
  output_sha256: string;
  max_record_bytes: number;
  chunk_count: number;
}

export function createChunkedJsonArtifact(serialized: string): {
  content: string;
  chunkCount: number;
  sha256: string;
} {
  if (byteLength(serialized) > COMPOSE_MAX_ARTIFACT_INPUT_BYTES) {
    throw new ComposeRuntimeError(
      "serialization",
      `Compose result exceeds the ${COMPOSE_MAX_ARTIFACT_INPUT_BYTES} byte artifact recovery input limit`,
    );
  }
  const records: string[] = [];
  let offset = 0;
  while (offset < serialized.length) {
    let low = 1;
    let high = Math.min(
      serialized.length - offset,
      COMPOSE_MAX_ARTIFACT_RECORD_BYTES,
    );
    let accepted = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      let end = offset + middle;
      const trailingCodeUnit = serialized.charCodeAt(end - 1);
      if (trailingCodeUnit >= 0xd800 && trailingCodeUnit <= 0xdbff) end -= 1;
      const record = JSON.stringify({
        index: records.length,
        data: serialized.slice(offset, end),
      });
      if (byteLength(record) <= COMPOSE_MAX_ARTIFACT_RECORD_BYTES) {
        accepted = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (accepted === 0) {
      throw new ComposeRuntimeError(
        "serialization",
        "Compose could not encode an oversized result recovery record",
      );
    }
    let end = offset + accepted;
    const trailingCodeUnit = serialized.charCodeAt(end - 1);
    if (trailingCodeUnit >= 0xd800 && trailingCodeUnit <= 0xdbff) end -= 1;
    records.push(
      JSON.stringify({
        index: records.length,
        data: serialized.slice(offset, end),
      }),
    );
    offset = end;
  }
  return {
    content: records.length > 0 ? `${records.join("\n")}\n` : "",
    chunkCount: records.length,
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
}

async function retainOversizedArtifact(
  serializedFinal: string,
  retainArtifact: NonNullable<ComposeRuntimeOptions["retainArtifact"]>,
): Promise<ComposeOversizedArtifactRecovery | null> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    COMPOSE_ARTIFACT_TIMEOUT_MS,
  );
  try {
    const encoded = createChunkedJsonArtifact(serializedFinal);
    const write = retainArtifact({
      content: encoded.content,
      extension: "jsonl",
      signal: controller.signal,
    }).catch(() => null);
    const retained = await Promise.race([
      write,
      new Promise<null>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(null), {
          once: true,
        });
      }),
    ]);
    if (!retained) return null;
    return {
      output_file: retained.path,
      output_format: "chunked-json-v1",
      output_bytes: byteLength(serializedFinal),
      output_sha256: encoded.sha256,
      max_record_bytes: COMPOSE_MAX_ARTIFACT_RECORD_BYTES,
      chunk_count: encoded.chunkCount,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function createOversizedFinalResult(
  serializedFinal: string,
  finalBytes: number,
  trace: ComposeTrace,
  artifact?: ComposeOversizedArtifactRecovery,
  warning?: string,
): ComposeToolResult {
  const error = new ComposeRuntimeError(
    "serialization",
    `Compose returned ${finalBytes} bytes; limit is ${COMPOSE_MAX_FINAL_BYTES} bytes. Reduce or aggregate inside the script.`,
  );
  const children = trace.children
    .slice(0, COMPOSE_MAX_RECOVERY_CHILDREN)
    .map(({ name, status }) => ({ name, status }));
  const preview = truncateUtf8(
    serializedFinal,
    COMPOSE_MAX_RECOVERY_PREVIEW_BYTES,
  );
  const payload = {
    error: error.message,
    kind: error.kind,
    recovery: {
      reason: "final_result_too_large",
      actual_bytes: finalBytes,
      limit_bytes: COMPOSE_MAX_FINAL_BYTES,
      preview,
      preview_bytes: byteLength(preview),
      preview_truncated: true,
      total_children: trace.totalChildren,
      completed_children: trace.completedChildren,
      bridged_bytes: trace.bridgedBytes,
      children,
      omitted_children: Math.max(0, trace.totalChildren - children.length),
      ...artifact,
      ...(warning ? { warning: truncate(warning, 256) } : {}),
      guidance: artifact
        ? "Use read_file to page the JSONL artifact, parse records in index order, and concatenate each data field to reconstruct the exact JSON result."
        : "Return a smaller aggregate, page/filter child calls, or split the workflow into multiple compose calls.",
    },
  };
  trace.status = "error";
  trace.errorKind = error.kind;
  return {
    data: payload,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
    error: { kind: error.kind, message: error.message },
    uiMeta: { composeTrace: trace },
  };
}

type ComposeBatchPolicy = "fail-fast" | "settled";

function accountBridgedValue(
  value: JsonValue,
  subject: string,
  state: ComposeRuntimeState,
): JsonValue {
  const serialized = serializeJson(value, subject);
  const bytes = byteLength(serialized);
  if (bytes > COMPOSE_MAX_CHILD_BYTES) {
    throw new ComposeRuntimeError(
      "serialization",
      `${subject} returned ${bytes} bytes; compose allows ${COMPOSE_MAX_CHILD_BYTES} bytes per child. Reduce the child result before composing it.`,
      undefined,
      "child_result_too_large",
    );
  }
  if (state.cumulativeChildBytes + bytes > COMPOSE_MAX_CUMULATIVE_CHILD_BYTES) {
    throw new ComposeRuntimeError(
      "serialization",
      `Compose child data exceeded the ${COMPOSE_MAX_CUMULATIVE_CHILD_BYTES} byte cumulative limit. Reduce, filter, paginate, or aggregate earlier.`,
      undefined,
      "cumulative_child_result_too_large",
    );
  }
  state.cumulativeChildBytes += bytes;
  state.trace.bridgedBytes = state.cumulativeChildBytes;
  return parseJson(serialized, subject);
}

function rejectedEnvelope(error: ComposeRuntimeError): JsonValue {
  return {
    status: "rejected",
    reason: {
      code: error.code ?? "child_handler_failed",
      message: truncate(error.message, COMPOSE_MAX_TRACE_MESSAGE_CHARS),
    },
  };
}

function isSettledChildError(error: ComposeRuntimeError): boolean {
  return (
    (error.kind === "child_failed" && error.code === "child_handler_failed") ||
    (error.kind === "serialization" && error.code === "child_result_too_large")
  );
}

async function executeOne(
  scope: ComposeExecutionScope,
  descriptor: ComposeToolDescriptor,
  state: ComposeRuntimeState,
  signal = state.abortController.signal,
  options: { prepared?: boolean; policy?: ComposeBatchPolicy } = {},
): Promise<JsonValue> {
  assertNotAborted(signal);
  if (!options.prepared)
    scope.preflightChild(descriptor.name, descriptor.input);
  if (!options.prepared && state.callCount >= COMPOSE_MAX_CHILD_CALLS) {
    throw new ComposeRuntimeError(
      "budget_exhausted",
      `Compose child-call limit of ${COMPOSE_MAX_CHILD_CALLS} reached. Reduce, filter, paginate, or memoize inside the script.`,
    );
  }

  if (!options.prepared) state.callCount += 1;
  const id = `compose-child-${state.nextTraceId++}`;
  const startedAt = Date.now();
  try {
    const result = await raceAbort(
      scope.executeChild(descriptor.name, descriptor.input, signal, {
        budgetReserved: options.prepared,
      }),
      signal,
    );
    assertNotAborted(signal);
    if (result.isError) {
      throw new ComposeRuntimeError(
        "child_failed",
        result.error?.message ?? `Tool '${descriptor.name}' failed`,
        undefined,
        "child_handler_failed",
      );
    }
    if (!("data" in result)) {
      throw new ComposeRuntimeError(
        "child_failed",
        `Tool '${descriptor.name}' did not return canonical structured data`,
        undefined,
        "canonical_result_required",
      );
    }
    const delivered =
      options.policy === "settled"
        ? ({ status: "fulfilled", value: result.data } as JsonValue)
        : (result.data as JsonValue);
    const value = accountBridgedValue(
      delivered,
      `Tool '${descriptor.name}' result`,
      state,
    );
    appendTrace(state.trace, {
      id,
      name: descriptor.name,
      status: "completed",
      durationMs: Date.now() - startedAt,
      inputSummary: summarizeInput(descriptor.input),
    });
    return value;
  } catch (error) {
    const classified = classifyError(error);
    if (options.policy === "settled" && isSettledChildError(classified)) {
      const envelope = accountBridgedValue(
        rejectedEnvelope(classified),
        `Tool '${descriptor.name}' rejected result`,
        state,
      );
      appendTrace(state.trace, {
        id,
        name: descriptor.name,
        status: "error",
        durationMs: Date.now() - startedAt,
        inputSummary: summarizeInput(descriptor.input),
        errorSummary: truncate(
          `${classified.code}: ${classified.message}`,
          COMPOSE_MAX_TRACE_MESSAGE_CHARS,
        ),
      });
      return envelope;
    }
    appendTrace(state.trace, {
      id,
      name: descriptor.name,
      status: classified.kind === "aborted" ? "cancelled" : "error",
      durationMs: Date.now() - startedAt,
      inputSummary: summarizeInput(descriptor.input),
      errorSummary: truncate(
        `${classified.kind}: ${classified.message}`,
        COMPOSE_MAX_TRACE_MESSAGE_CHARS,
      ),
    });
    throw classified;
  }
}

async function executeBatch(
  scope: ComposeExecutionScope,
  descriptors: ComposeToolDescriptor[],
  state: ComposeRuntimeState,
  policy: ComposeBatchPolicy,
): Promise<JsonValue[]> {
  if (descriptors.length > COMPOSE_MAX_BATCH_SIZE) {
    throw new ComposeRuntimeError(
      "validation",
      `toolAll accepts at most ${COMPOSE_MAX_BATCH_SIZE} descriptors`,
    );
  }
  if (state.callCount + descriptors.length > COMPOSE_MAX_CHILD_CALLS) {
    throw new ComposeRuntimeError(
      "budget_exhausted",
      `toolAll would exceed the compose child-call limit of ${COMPOSE_MAX_CHILD_CALLS}. Reduce, filter, paginate, or memoize inside the script.`,
    );
  }
  for (const descriptor of descriptors) {
    scope.preflightChild(descriptor.name, descriptor.input);
  }
  scope.reserveChildren(descriptors.length);
  if (descriptors.length === 0) return [];
  state.callCount += descriptors.length;

  const output = Array.from<JsonValue>({ length: descriptors.length });
  const batchController = new AbortController();
  const abortBatch = () => batchController.abort();
  state.abortController.signal.addEventListener("abort", abortBatch, {
    once: true,
  });
  let cursor = 0;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (firstError === undefined) {
      assertNotAborted(batchController.signal);
      const index = cursor++;
      if (index >= descriptors.length) return;
      try {
        output[index] = await executeOne(
          scope,
          descriptors[index],
          state,
          batchController.signal,
          { prepared: true, policy },
        );
      } catch (error) {
        firstError ??= error;
        batchController.abort();
      }
    }
  };
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(COMPOSE_MAX_CONCURRENCY, descriptors.length) },
        worker,
      ),
    );
    if (firstError !== undefined) throw firstError;
    return output;
  } finally {
    state.abortController.signal.removeEventListener("abort", abortBatch);
  }
}

function dumpQuickJSError(
  context: QuickJSAsyncContext,
  handle: QuickJSHandle,
  state: ComposeRuntimeState,
  timedOut: boolean,
): ComposeRuntimeError {
  const dumped = context.dump(handle) as unknown;
  const details =
    typeof dumped === "object" && dumped !== null
      ? (dumped as Record<string, unknown>)
      : {};
  const message =
    typeof details.message === "string"
      ? details.message
      : typeof dumped === "string"
        ? dumped
        : "Compose script failed";
  const name = typeof details.name === "string" ? details.name : "Error";
  const stack =
    typeof details.stack === "string"
      ? truncate(details.stack, COMPOSE_MAX_STACK_CHARS)
      : undefined;
  if (state.abortController.signal.aborted) {
    return new ComposeRuntimeError("aborted", "Compose execution was aborted");
  }
  if (timedOut || (name === "InternalError" && message === "interrupted")) {
    return new ComposeRuntimeError(
      "timeout",
      `Compose exceeded the ${COMPOSE_TIMEOUT_MS}ms wall-time limit`,
      stack,
    );
  }
  const text = `${name}: ${message}`.toLowerCase();
  if (text.includes("out of memory") || text.includes("allocation")) {
    return new ComposeRuntimeError(
      "memory_limit",
      `Compose exceeded the ${COMPOSE_MEMORY_LIMIT_BYTES / 1024 / 1024} MiB memory limit`,
      stack,
    );
  }
  if (message.startsWith("Compose data contains ")) {
    return new ComposeRuntimeError("serialization", message, stack);
  }
  return new ComposeRuntimeError("script_error", `${name}: ${message}`, stack);
}

function validateParams(params: ComposeParams): void {
  if (typeof params.script !== "string" || params.script.trim().length === 0) {
    throw new ComposeRuntimeError(
      "validation",
      "Compose script must be a non-empty string",
    );
  }
  if (
    /\.\s*constructor\b/u.test(params.script) ||
    /\[\s*["']constructor["']\s*\]/u.test(params.script) ||
    /\bfunction\s*\*/u.test(params.script) ||
    /\basync\s+function\b/u.test(params.script) ||
    /\basync\s*\(/u.test(params.script)
  ) {
    throw new ComposeRuntimeError(
      "policy",
      "Dynamic constructors, generators, and async functions are disabled in compose scripts",
    );
  }
  const scriptBytes = byteLength(params.script);
  if (scriptBytes > COMPOSE_MAX_SCRIPT_BYTES) {
    throw new ComposeRuntimeError(
      "validation",
      `Compose script is ${scriptBytes} bytes; limit is ${COMPOSE_MAX_SCRIPT_BYTES} bytes`,
    );
  }
  if (
    params.description !== undefined &&
    (typeof params.description !== "string" ||
      byteLength(params.description) > COMPOSE_MAX_DESCRIPTION_BYTES ||
      /[\r\n]/u.test(params.description))
  ) {
    throw new ComposeRuntimeError(
      "validation",
      `Compose description must be one line and at most ${COMPOSE_MAX_DESCRIPTION_BYTES} bytes`,
    );
  }
}

function guestWrapper(script: string): string {
  return `"use strict";
const globalThis = undefined;
const self = undefined;
const window = undefined;
const global = undefined;
const process = undefined;
const require = undefined;
const module = undefined;
const exports = undefined;
const Function = undefined;
const __composeSerialize = (value) => {
  const ancestors = new Set();
  const normalize = (current) => {
    const type = typeof current;
    if (type === "undefined" || type === "function" || type === "symbol" || type === "bigint") {
      throw new TypeError("Compose data contains unsupported " + type + " data");
    }
    if (type === "number" && !Number.isFinite(current)) {
      throw new TypeError("Compose data contains a non-finite number");
    }
    if (current === null || type === "string" || type === "number" || type === "boolean") return current;
    if (ancestors.has(current)) throw new TypeError("Compose data contains cyclic data");
    ancestors.add(current);
    try {
      if (Array.isArray(current)) return current.map(normalize);
      const output = {};
      for (const key of Object.keys(current)) output[key] = normalize(current[key]);
      return output;
    } finally {
      ancestors.delete(current);
    }
  };
  return JSON.stringify(normalize(value));
};
const tool = (name, input) => JSON.parse(__composeBridge(__composeSerialize({ operation: "tool", name, input })));
const toolAll = (descriptors) => JSON.parse(__composeBridge(__composeSerialize({ operation: "toolAll", descriptors: descriptors === undefined ? null : descriptors })));
const toolAllSettled = (descriptors) => JSON.parse(__composeBridge(__composeSerialize({ operation: "toolAllSettled", descriptors: descriptors === undefined ? null : descriptors })));
const __composeResult = (function () {
${script}
})();
__composeSerialize(__composeResult);`;
}

const LOCKDOWN_SCRIPT = `
Object.defineProperty(Function.prototype, "constructor", { value: undefined, writable: false, configurable: true });
Object.defineProperty(globalThis, "Function", { value: undefined, writable: false, configurable: true });
Object.defineProperty(globalThis, "eval", { value: undefined, writable: false, configurable: true });
`;

async function createRuntime(
  wasmPath: string,
): Promise<{ runtime: QuickJSAsyncRuntime; context: QuickJSAsyncContext }> {
  const wasmBytes = await readFile(wasmPath);
  const variant = newVariant(asyncifyVariant, {
    wasmBinary: wasmBytes.buffer.slice(
      wasmBytes.byteOffset,
      wasmBytes.byteOffset + wasmBytes.byteLength,
    ),
  });
  const module = await newQuickJSAsyncWASMModuleFromVariant(variant);
  const runtime = module.newRuntime({
    memoryLimitBytes: COMPOSE_MEMORY_LIMIT_BYTES,
  });
  const context = runtime.newContext({
    intrinsics: { ...DefaultIntrinsics, Promise: false },
  });
  return { runtime, context };
}

export async function handleCompose({
  params,
  scope,
  signal,
  wasmPath,
  retainArtifact,
}: ComposeRuntimeOptions): Promise<ComposeToolResult> {
  const trace: ComposeTrace = {
    description: params.description,
    status: "running",
    children: [],
    totalChildren: 0,
    completedChildren: 0,
    succeededChildren: 0,
    failedChildren: 0,
    cancelledChildren: 0,
    toolAllBatchCount: 0,
    toolAllSettledBatchCount: 0,
    bridgedBytes: 0,
  };
  const state: ComposeRuntimeState = {
    callCount: 0,
    cumulativeChildBytes: 0,
    toolAllBatchCount: 0,
    toolAllSettledBatchCount: 0,
    nextTraceId: 1,
    trace,
    bridgeActive: false,
    abortController: new AbortController(),
  };
  let runtime: QuickJSAsyncRuntime | undefined;
  let context: QuickJSAsyncContext | undefined;
  let bridgeHandle: QuickJSHandle | undefined;
  let timedOut = false;
  let bridgeFailure: ComposeRuntimeError | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let deadline = Number.POSITIVE_INFINITY;
  const abort = () => state.abortController.abort();
  let cleanedUp = false;
  const cleanupRuntime = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (timeout !== undefined) clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    state.abortController.abort();
    runtime?.removeInterruptHandler();
    if (context?.alive) {
      context.setProp(context.global, "__composeBridge", context.undefined);
    }
    bridgeHandle?.dispose();
    context?.dispose();
    runtime?.dispose();
  };

  try {
    validateParams(params);
    assertNotAborted(signal);
    signal.addEventListener("abort", abort, { once: true });
    deadline = Date.now() + COMPOSE_TIMEOUT_MS;
    timeout = setTimeout(() => {
      timedOut = true;
      state.abortController.abort();
    }, COMPOSE_TIMEOUT_MS);

    ({ runtime, context } = await createRuntime(wasmPath));
    assertNotAborted(state.abortController.signal);
    runtime.setInterruptHandler(() => {
      if (!timedOut && Date.now() >= deadline) timedOut = true;
      return timedOut || state.abortController.signal.aborted;
    });
    runtime.setModuleLoader(() => ({
      error: new Error("Module access is disabled"),
    }));
    const lockdownResult = await context.evalCodeAsync(
      LOCKDOWN_SCRIPT,
      "compose-lockdown.js",
      { type: "global", strict: true },
    );
    if (isFail(lockdownResult)) {
      const error = dumpQuickJSError(
        context,
        lockdownResult.error,
        state,
        timedOut,
      );
      lockdownResult.error.dispose();
      throw error;
    }
    lockdownResult.value.dispose();

    bridgeHandle = context.newAsyncifiedFunction(
      "__composeBridge",
      async (requestHandle) => {
        if (state.bridgeActive) {
          throw new ComposeRuntimeError(
            "policy",
            "Only one compose host bridge may be active at a time",
          );
        }
        state.bridgeActive = true;
        try {
          assertNotAborted(state.abortController.signal);
          const requestText = context!.getString(requestHandle);
          const request = assertRecord(
            parseJson(requestText, "Compose bridge request"),
            "Compose bridge request",
          );
          let result: JsonValue;
          if (request.operation === "tool") {
            result = await executeOne(
              scope,
              validateDescriptor(request, "tool request"),
              state,
            );
          } else if (
            request.operation === "toolAll" ||
            request.operation === "toolAllSettled"
          ) {
            const policy: ComposeBatchPolicy =
              request.operation === "toolAllSettled" ? "settled" : "fail-fast";
            state.toolAllBatchCount += 1;
            state.trace.toolAllBatchCount = state.toolAllBatchCount;
            if (policy === "settled") {
              state.toolAllSettledBatchCount += 1;
              state.trace.toolAllSettledBatchCount =
                state.toolAllSettledBatchCount;
            }
            if (!Array.isArray(request.descriptors)) {
              throw new ComposeRuntimeError(
                "validation",
                `${request.operation} requires an array of descriptors`,
              );
            }
            const descriptors = request.descriptors.map((descriptor, index) =>
              validateDescriptor(
                descriptor,
                `${request.operation} descriptor ${index}`,
              ),
            );
            result = await executeBatch(scope, descriptors, state, policy);
          } else {
            throw new ComposeRuntimeError(
              "validation",
              "Unknown compose bridge operation",
            );
          }
          return context!.newString(
            serializeJson(result, "Compose bridge result"),
          );
        } catch (error) {
          bridgeFailure = classifyError(error);
          throw bridgeFailure;
        } finally {
          state.bridgeActive = false;
        }
      },
    );
    context.setProp(context.global, "__composeBridge", bridgeHandle);

    const evaluation = await context.evalCodeAsync(
      guestWrapper(params.script),
      COMPOSE_FILENAME,
      { type: "global", strict: true, backtraceBarrier: true },
    );
    if (isFail(evaluation)) {
      const error =
        bridgeFailure ??
        dumpQuickJSError(context, evaluation.error, state, timedOut);
      evaluation.error.dispose();
      throw error;
    }
    const serializedFinal = context.getString(evaluation.value);
    evaluation.value.dispose();
    assertNotAborted(state.abortController.signal);
    const finalBytes = byteLength(serializedFinal);
    if (finalBytes > COMPOSE_MAX_FINAL_BYTES) {
      cleanupRuntime();
      if (!retainArtifact || signal.aborted) {
        return createOversizedFinalResult(serializedFinal, finalBytes, trace);
      }
      const artifact = await retainOversizedArtifact(
        serializedFinal,
        retainArtifact,
      );
      return createOversizedFinalResult(
        serializedFinal,
        finalBytes,
        trace,
        artifact ?? undefined,
        artifact
          ? undefined
          : "Exact result retention was unavailable; use the bounded preview or rerun with a smaller aggregate.",
      );
    }
    return createResult(
      parseJson(serializedFinal, "Compose return value"),
      trace,
    );
  } catch (error) {
    let classified = classifyError(error);
    if (timedOut && classified.kind === "aborted") {
      classified = new ComposeRuntimeError(
        "timeout",
        `Compose exceeded the ${COMPOSE_TIMEOUT_MS}ms wall-time limit`,
      );
    }
    return createResult(undefined, trace, classified);
  } finally {
    cleanupRuntime();
  }
}
