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
import type { AgentResolvedModelSelection } from "./turnContracts.js";

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
  readonly displayInput:
    | ((input: Record<string, unknown>) => unknown)
    | undefined;
  validate(input: unknown): HostToolValidationResult;
  execute(
    input: Record<string, unknown>,
    context: HostToolExecutionContext<TPrincipal>,
  ): Promise<HostToolResult>;
}

export interface HostToolResolveRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
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
