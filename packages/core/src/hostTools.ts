import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

import type { AgentPrincipal } from "./modelIdentity.js";
import type {
  CoreModelContentBlock,
  CoreModelJsonSchema,
  CoreModelToolDefinition,
} from "./modelRuntime.js";
import {
  isEmbeddedAgentToolPresentation,
  type EmbeddedAgentToolPresentation,
} from "@agentlink/protocol/embedded-agent-presentation";
import type {
  AgentResolvedModelSelection,
  AgentTurnInput,
} from "./turnContracts.js";
import { z, type ZodType } from "zod";

export type HostToolEffect = "read" | "write" | "external";
export type HostToolAuthorization = "none" | "required";

export interface HostToolResult {
  /** Bounded content replayed to the model. */
  readonly modelContent: string | CoreModelContentBlock[];
  /** Optional explicitly safe content projected into public events. */
  readonly displayContent?: unknown;
  readonly isError?: boolean;
}

export interface HostToolExecutionContext<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly model: AgentResolvedModelSelection;
  readonly signal: AbortSignal | undefined;
}

export interface HostToolDefinitionOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: CoreModelJsonSchema;
  readonly effect: HostToolEffect;
  readonly parallelSafe?: boolean;
  readonly authorization?: HostToolAuthorization;
  /** Display-safe labels and risk metadata; never interpreted as authority. */
  readonly presentation?: EmbeddedAgentToolPresentation;
  readonly displayInput?: (input: Record<string, unknown>) => unknown;
  readonly handler: (
    input: Record<string, unknown>,
    context: HostToolExecutionContext<TPrincipal>,
  ) => Promise<HostToolResult>;
}

export interface HostTool<TPrincipal extends AgentPrincipal = AgentPrincipal> {
  readonly definition: CoreModelToolDefinition;
  readonly effect: HostToolEffect;
  readonly parallelSafe: boolean;
  readonly authorization: HostToolAuthorization;
  readonly presentation: EmbeddedAgentToolPresentation | undefined;
  readonly displayInput:
    | ((input: Record<string, unknown>) => unknown)
    | undefined;
  /** Validate and return the canonical value used by approval and execution. */
  validate(input: unknown): HostToolValidationResult;
  execute(
    input: Record<string, unknown>,
    context: HostToolExecutionContext<TPrincipal>,
  ): Promise<HostToolResult>;
  /** Execute a value already returned by validate without parsing it again. */
  executeValidated(
    input: Record<string, unknown>,
    context: HostToolExecutionContext<TPrincipal>,
  ): Promise<HostToolResult>;
}

export interface ZodHostToolDefinitionOptions<
  TOutput extends Record<string, unknown>,
  TInput = unknown,
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<TOutput, TInput>;
  readonly effect: HostToolEffect;
  readonly parallelSafe?: boolean;
  readonly authorization?: HostToolAuthorization;
  readonly presentation?: EmbeddedAgentToolPresentation;
  readonly displayInput?: (input: Readonly<TOutput>) => unknown;
  readonly handler: (
    input: TOutput,
    context: HostToolExecutionContext<TPrincipal>,
  ) => Promise<HostToolResult>;
}

export interface HostToolResolveRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
  /** Host-authenticated input for this turn, including any bounded attachments. */
  readonly input: AgentTurnInput;
}

export type HostToolResolver<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> = (
  request: HostToolResolveRequest<TPrincipal>,
) => readonly HostTool<TPrincipal>[] | Promise<readonly HostTool<TPrincipal>[]>;

export interface HostToolValidationIssue {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

export type HostToolValidationResult =
  | { readonly valid: true; readonly input: Record<string, unknown> }
  | {
      readonly valid: false;
      readonly issues: readonly HostToolValidationIssue[];
    };

export class HostToolInputValidationError extends Error {
  readonly code = "tool_input_invalid";
  readonly retryable = false;

  constructor(
    readonly toolName: string,
    readonly issues: readonly HostToolValidationIssue[],
  ) {
    super(formatHostToolValidationError(toolName, issues));
    this.name = "HostToolInputValidationError";
  }
}

/**
 * An explicitly display-safe host-tool failure. Arbitrary thrown errors remain
 * redacted so provider, credential, filesystem, and network details cannot leak.
 */
export class HostToolPublicError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { readonly code?: string; readonly retryable?: boolean } = {},
  ) {
    const bounded = boundText(message.trim(), 1_000);
    if (!bounded)
      throw new Error("Host tool public error message must not be empty");
    super(bounded);
    this.name = "HostToolPublicError";
    this.code = options.code?.trim() || "tool_execution_failed";
    this.retryable = options.retryable ?? false;
  }
}

const HOST_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Define one immutable, schema-validated host tool. */
export function defineTool<TPrincipal extends AgentPrincipal = AgentPrincipal>(
  options: HostToolDefinitionOptions<TPrincipal>,
): HostTool<TPrincipal> {
  const name = options.name.trim();
  const description = options.description.trim();
  if (!HOST_TOOL_NAME_PATTERN.test(name)) {
    throw new Error(
      "Host tool name must start with a letter and contain at most 64 letters, digits, underscores, or hyphens",
    );
  }
  if (!description)
    throw new Error(`Host tool "${name}" description must not be empty`);
  if (!isPlainObject(options.inputSchema)) {
    throw new Error(`Host tool "${name}" input schema must be an object`);
  }

  let compiledSchema: CoreModelJsonSchema;
  let validateInput: ValidateFunction;
  try {
    compiledSchema = structuredClone(options.inputSchema);
    validateInput = new Ajv2020({
      allErrors: true,
      strict: true,
      validateFormats: false,
    }).compile(compiledSchema);
  } catch (error) {
    throw new Error(
      `Host tool "${name}" input schema is invalid: ${boundedMessage(error)}`,
    );
  }

  const { effect, authorization, parallelSafe } = normalizeToolMetadata(
    name,
    options,
  );
  validateToolPresentation(name, options.presentation);

  const definition: CoreModelToolDefinition = Object.freeze({
    name,
    description,
    input_schema: deepFreeze(structuredClone(compiledSchema)),
  });
  return Object.freeze({
    definition,
    effect,
    parallelSafe,
    authorization,
    presentation: options.presentation
      ? deepFreeze(structuredClone(options.presentation))
      : undefined,
    displayInput: options.displayInput,
    validate(input: unknown): HostToolValidationResult {
      if (validateInput(input) && isPlainObject(input)) {
        return { valid: true, input };
      }
      const issues = normalizeValidationIssues(validateInput.errors, input);
      return { valid: false, issues };
    },
    async execute(
      input: Record<string, unknown>,
      context: HostToolExecutionContext<TPrincipal>,
    ) {
      const validation =
        validateInput(input) && isPlainObject(input)
          ? ({ valid: true, input } as const)
          : ({
              valid: false,
              issues: normalizeValidationIssues(validateInput.errors, input),
            } as const);
      if (!validation.valid) {
        throw new HostToolInputValidationError(name, validation.issues);
      }
      return await options.handler(validation.input, context);
    },
    async executeValidated(
      input: Record<string, unknown>,
      context: HostToolExecutionContext<TPrincipal>,
    ) {
      return await options.handler(input, context);
    },
  });
}

/**
 * Define a tool from one Zod schema. Its parsed/defaulted object becomes the
 * canonical value used for approval display, durable continuation, and execution.
 */
export function defineZodTool<
  TOutput extends Record<string, unknown>,
  TInput = unknown,
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: ZodHostToolDefinitionOptions<TOutput, TInput, TPrincipal>,
): HostTool<TPrincipal> {
  const name = options.name.trim();
  const description = options.description.trim();
  validateToolIdentity(name, description);
  const { effect, authorization, parallelSafe } = normalizeToolMetadata(
    name,
    options,
  );
  validateToolPresentation(name, options.presentation);

  let inputSchema: CoreModelJsonSchema;
  try {
    const generated = z.toJSONSchema(options.inputSchema, {
      io: "input",
      target: "draft-2020-12",
    }) as Record<string, unknown>;
    const { $schema: _dialect, ...schema } = generated;
    if (!isPlainObject(schema)) throw new Error("schema is not an object");
    if (schema.type !== "object") {
      throw new Error("top-level input schema must describe an object");
    }
    inputSchema = structuredClone(schema) as CoreModelJsonSchema;
  } catch (error) {
    throw new Error(
      `Host tool "${name}" Zod schema cannot be represented as JSON Schema: ${boundedMessage(error)}`,
    );
  }

  const parse = (input: unknown): HostToolValidationResult => {
    const result = options.inputSchema.safeParse(input);
    if (result.success && isPlainObject(result.data)) {
      const jsonIssue = jsonCompatibilityIssue(result.data);
      return jsonIssue
        ? { valid: false, issues: [jsonIssue] }
        : { valid: true, input: result.data };
    }
    if (result.success) {
      return {
        valid: false,
        issues: [
          {
            path: "$",
            keyword: "type",
            message: "parsed value must be an object",
          },
        ],
      };
    }
    return {
      valid: false,
      issues: result.error.issues.slice(0, 20).map((issue) => ({
        path: zodIssuePath(issue.path),
        keyword: issue.code,
        message: boundText(issue.message, 200),
      })),
    };
  };
  const definition: CoreModelToolDefinition = Object.freeze({
    name,
    description,
    input_schema: deepFreeze(structuredClone(inputSchema)),
  });
  return Object.freeze({
    definition,
    effect,
    parallelSafe,
    authorization,
    presentation: options.presentation
      ? deepFreeze(structuredClone(options.presentation))
      : undefined,
    displayInput: options.displayInput
      ? (input: Record<string, unknown>) =>
          options.displayInput!(input as TOutput)
      : undefined,
    validate: parse,
    async execute(
      input: Record<string, unknown>,
      context: HostToolExecutionContext<TPrincipal>,
    ) {
      const validation = parse(input);
      if (!validation.valid) {
        throw new HostToolInputValidationError(name, validation.issues);
      }
      return await options.handler(validation.input as TOutput, context);
    },
    async executeValidated(
      input: Record<string, unknown>,
      context: HostToolExecutionContext<TPrincipal>,
    ) {
      return await options.handler(input as TOutput, context);
    },
  });
}

export function formatHostToolValidationError(
  toolName: string,
  issues: readonly HostToolValidationIssue[],
): string {
  const detail = issues
    .slice(0, 5)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");
  return boundText(
    `Tool "${toolName}" input is invalid${detail ? `: ${detail}` : ""}`,
    1000,
  );
}

function normalizeValidationIssues(
  errors: ErrorObject[] | null | undefined,
  input: unknown,
): HostToolValidationIssue[] {
  if (!isPlainObject(input)) {
    return [
      {
        path: "$",
        keyword: "type",
        message: "must be an object",
      },
    ];
  }
  return (errors ?? []).slice(0, 20).map((error) => ({
    path: error.instancePath ? `$${error.instancePath}` : "$",
    keyword: error.keyword,
    message: boundText(error.message ?? "is invalid", 200),
  }));
}

function validateToolIdentity(name: string, description: string): void {
  if (!HOST_TOOL_NAME_PATTERN.test(name)) {
    throw new Error(
      "Host tool name must start with a letter and contain at most 64 letters, digits, underscores, or hyphens",
    );
  }
  if (!description)
    throw new Error(`Host tool "${name}" description must not be empty`);
}

function normalizeToolMetadata(
  name: string,
  options: {
    readonly effect: HostToolEffect;
    readonly authorization?: HostToolAuthorization;
    readonly parallelSafe?: boolean;
  },
): {
  effect: HostToolEffect;
  authorization: HostToolAuthorization;
  parallelSafe: boolean;
} {
  const effect = options.effect;
  if (effect !== "read" && effect !== "write" && effect !== "external") {
    throw new Error(`Host tool "${name}" effect is invalid`);
  }
  const authorization = options.authorization ?? "none";
  if (authorization !== "none" && authorization !== "required") {
    throw new Error(`Host tool "${name}" authorization is invalid`);
  }
  const parallelSafe = options.parallelSafe === true;
  if (parallelSafe && effect !== "read") {
    throw new Error(
      `Host tool "${name}" can be parallel-safe only when effect is "read"`,
    );
  }
  if (parallelSafe && authorization !== "none") {
    throw new Error(
      `Host tool "${name}" cannot be parallel-safe when authorization is required`,
    );
  }
  return { effect, authorization, parallelSafe };
}

function validateToolPresentation(
  name: string,
  presentation: EmbeddedAgentToolPresentation | undefined,
): void {
  if (
    presentation !== undefined &&
    !isEmbeddedAgentToolPresentation(presentation)
  ) {
    throw new Error(`Host tool "${name}" presentation metadata is invalid`);
  }
}

function jsonCompatibilityIssue(
  value: unknown,
  path = "$",
  ancestors = new Set<object>(),
): HostToolValidationIssue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? undefined
      : { path, keyword: "json", message: "must be a finite number" };
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return { path, keyword: "json", message: "must not contain a cycle" };
    }
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (item === undefined) {
        ancestors.delete(value);
        return {
          path: `${path}[${index}]`,
          keyword: "json",
          message: "must not be undefined",
        };
      }
      const issue = jsonCompatibilityIssue(
        item,
        `${path}[${index}]`,
        ancestors,
      );
      if (issue) {
        ancestors.delete(value);
        return issue;
      }
    }
    ancestors.delete(value);
    return undefined;
  }
  if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return {
        path,
        keyword: "json",
        message: "must contain only plain JSON objects",
      };
    }
    if (ancestors.has(value)) {
      return { path, keyword: "json", message: "must not contain a cycle" };
    }
    ancestors.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        ancestors.delete(value);
        return {
          path: `${path}.${key}`,
          keyword: "json",
          message: "must not be undefined",
        };
      }
      const issue = jsonCompatibilityIssue(item, `${path}.${key}`, ancestors);
      if (issue) {
        ancestors.delete(value);
        return issue;
      }
    }
    ancestors.delete(value);
    return undefined;
  }
  return {
    path,
    keyword: "json",
    message: "must be JSON-serializable",
  };
}

function zodIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "$";
  return `$${path
    .map((part) =>
      typeof part === "number"
        ? `[${part}]`
        : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(part))
          ? `.${String(part)}`
          : `[${JSON.stringify(String(part))}]`,
    )
    .join("")}`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedMessage(error: unknown): string {
  return boundText(error instanceof Error ? error.message : String(error), 300);
}

function boundText(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}
