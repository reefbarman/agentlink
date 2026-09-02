import {
  defineTool,
  type AgentPrincipal,
  type HostToolResolver,
} from "@agentlink/core";
import { spawn } from "node:child_process";
import path from "node:path";

const MAX_COMMANDS = 20;
const MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 60_000;

/** One exact, host-approved non-interactive process launch. */
export interface NodeHostCommand {
  readonly id: string;
  /** Absolute executable path. Shell lookup and shell parsing are unavailable. */
  readonly command: string;
  /** Fully host-selected arguments; the model cannot append arbitrary arguments. */
  readonly args: readonly string[];
  /** Explicit absolute process directory; no current directory is inherited. */
  readonly cwd: string;
  /** Complete child environment; ambient process.env is never inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly description?: string;
  readonly timeoutMs?: number;
  readonly maxOutputChars?: number;
}

export interface ResolveNodeHostCommandsRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
}

/** Resolve exact commands for one authenticated principal/session/turn. */
export type ResolveNodeHostCommands<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> = (
  request: ResolveNodeHostCommandsRequest<TPrincipal>,
) => readonly NodeHostCommand[] | Promise<readonly NodeHostCommand[]>;

/** Required host policy check before each process launch. */
export interface NodeHostCommandLaunchRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends ResolveNodeHostCommandsRequest<TPrincipal> {
  readonly command: Readonly<NodeHostCommand>;
}

export interface CreateNodeHostCommandToolsOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly resolveCommands: ResolveNodeHostCommands<TPrincipal>;
  /** Required default-deny process policy, checked on discovery and launch. */
  readonly authorizeLaunch: (
    request: NodeHostCommandLaunchRequest<TPrincipal>,
  ) => boolean | Promise<boolean>;
  readonly maxCommands?: number;
  readonly maxOutputChars?: number;
}

/**
 * Build separately authorized non-PTY tools for exact host-selected commands.
 * It has no shell parser, terminal persistence, sandbox policy, PTY, HOME, or
 * ambient environment authority. Hosts own all of those higher-level policies.
 */
export function createNodeHostCommandTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateNodeHostCommandToolsOptions<TPrincipal>,
): HostToolResolver<TPrincipal> {
  const maxCommands = boundedInteger(
    options.maxCommands ?? MAX_COMMANDS,
    "maxCommands",
    MAX_COMMANDS,
  );
  const maxOutputChars = boundedInteger(
    options.maxOutputChars ?? MAX_OUTPUT_CHARS,
    "maxOutputChars",
    MAX_OUTPUT_CHARS,
  );

  return async (request) => {
    const commands = await resolveCommands(
      options.resolveCommands,
      request,
      maxCommands,
    );
    const tools = [];
    const names = new Set<string>();
    for (const command of commands) {
      if (!(await options.authorizeLaunch({ ...request, command }))) continue;
      const name = `command_${command.id}`;
      if (!validToolName(name) || names.has(name)) continue;
      names.add(name);
      tools.push(
        defineTool<TPrincipal>({
          name,
          description:
            command.description ?? `Run host-approved command ${command.id}.`,
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          effect: "external",
          authorization: "required",
          displayInput: () => ({ command: command.id }),
          handler: async (_input, context) => {
            if (!sameTurn(request, context))
              return error(command.id, "command_turn_mismatch");
            if (!(await options.authorizeLaunch({ ...request, command }))) {
              return error(command.id, "command_launch_not_authorized");
            }
            const result = await executeCommand(
              command,
              context.signal,
              maxOutputChars,
            );
            return {
              modelContent: JSON.stringify(result),
              displayContent: {
                command: command.id,
                exitCode: result.exitCode,
                ...(result.timedOut ? { timedOut: true } : {}),
                ...(result.cancelled ? { cancelled: true } : {}),
                ...(result.outputTruncated ? { outputTruncated: true } : {}),
              },
              ...(result.exitCode === 0 && !result.timedOut && !result.cancelled
                ? {}
                : { isError: true }),
            };
          },
        }),
      );
    }
    return tools;
  };
}

async function resolveCommands<TPrincipal extends AgentPrincipal>(
  resolve: ResolveNodeHostCommands<TPrincipal>,
  request: ResolveNodeHostCommandsRequest<TPrincipal>,
  limit: number,
): Promise<readonly NodeHostCommand[]> {
  const ids = new Set<string>();
  const commands: NodeHostCommand[] = [];
  for (const command of await resolve(request)) {
    if (ids.has(command.id) || !validCommand(command)) continue;
    ids.add(command.id);
    commands.push(cloneCommand(command));
    if (commands.length === limit) break;
  }
  return commands;
}

async function executeCommand(
  command: Readonly<NodeHostCommand>,
  signal: AbortSignal | undefined,
  hostMaximum: number,
): Promise<{
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly timedOut?: true;
  readonly cancelled?: true;
}> {
  const maximum = Math.min(hostMaximum, command.maxOutputChars ?? hostMaximum);
  const timeoutMs = boundedTimeout(command.timeoutMs);
  return await new Promise((resolve) => {
    const child = spawn(command.command, [...command.args], {
      cwd: command.cwd,
      env: { ...command.env },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let outputTruncated = false;
    let timedOut = false;
    let cancelled = signal?.aborted === true;
    let settled = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const append = (chunk: Buffer) => {
      if (output.length >= maximum) {
        outputTruncated = true;
        return;
      }
      const text = chunk.toString("utf8");
      const remaining = maximum - output.length;
      output += text.slice(0, remaining);
      outputTruncated ||= text.length > remaining;
    };
    const stop = () => {
      if (!child.killed) child.kill("SIGTERM");
      // A non-cooperative child must not outlive the fixed host deadline or
      // cancellation signal. Do not leave a process waiting indefinitely.
      forceKill ??= setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1_000);
      forceKill.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timeout.unref();
    const abort = () => {
      cancelled = true;
      stop();
    };
    signal?.addEventListener("abort", abort, { once: true });
    // The signal can already be aborted between the initial observation and
    // listener registration; terminate the newly spawned child in that window.
    if (signal?.aborted) abort();
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      signal?.removeEventListener("abort", abort);
      resolve({
        command: command.id,
        exitCode,
        output: boundText(output, maximum),
        outputTruncated,
        ...(timedOut ? { timedOut: true } : {}),
        ...(cancelled ? { cancelled: true } : {}),
      });
    };
    child.once("error", () => finish(null));
    child.once("close", (exitCode) => finish(exitCode));
  });
}

function validCommand(command: NodeHostCommand): boolean {
  return (
    validId(command.id) &&
    path.isAbsolute(command.command) &&
    path.isAbsolute(command.cwd) &&
    Array.isArray(command.args) &&
    command.args.every(validArgument) &&
    validEnvironment(command.env) &&
    (command.timeoutMs === undefined || validTimeout(command.timeoutMs)) &&
    (command.maxOutputChars === undefined ||
      validBound(command.maxOutputChars, MAX_OUTPUT_CHARS))
  );
}

function validId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(value);
}

function validToolName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
}

function validArgument(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0");
}

function validEnvironment(
  value: unknown,
): value is Readonly<Record<string, string>> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([name, entry]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        typeof entry === "string" &&
        !entry.includes("\0"),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validTimeout(value: number): boolean {
  return validBound(value, DEFAULT_TIMEOUT_MS);
}

function validBound(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function boundedInteger(value: number, field: string, maximum: number): number {
  if (!validBound(value, maximum)) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function boundedTimeout(value: number | undefined): number {
  return value === undefined
    ? DEFAULT_TIMEOUT_MS
    : boundedInteger(value, "timeoutMs", DEFAULT_TIMEOUT_MS);
}

function cloneCommand(command: NodeHostCommand): NodeHostCommand {
  return {
    id: command.id,
    command: command.command,
    args: [...command.args],
    cwd: command.cwd,
    env: { ...command.env },
    ...(command.description ? { description: command.description } : {}),
    ...(command.timeoutMs === undefined
      ? {}
      : { timeoutMs: command.timeoutMs }),
    ...(command.maxOutputChars === undefined
      ? {}
      : { maxOutputChars: command.maxOutputChars }),
  };
}

function sameTurn<TPrincipal extends AgentPrincipal>(
  discovery: ResolveNodeHostCommandsRequest<TPrincipal>,
  invocation: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly turnId: string;
  },
): boolean {
  return (
    discovery.principal.tenantId === invocation.principal.tenantId &&
    discovery.principal.subjectId === invocation.principal.subjectId &&
    discovery.sessionId === invocation.sessionId &&
    discovery.turnId === invocation.turnId
  );
}

function error(command: string, code: string) {
  return {
    modelContent: JSON.stringify({ error: code, command }),
    displayContent: { command, isError: true },
    isError: true,
  };
}

function boundText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
