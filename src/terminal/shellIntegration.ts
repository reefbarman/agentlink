import { Buffer } from "node:buffer";

const OSC_NAMESPACE = "697;AgentLink";
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type ShellIntegrationKind = "bash" | "zsh";
export type ShellIntegrationMode = "raw" | "integrated";

export type ShellIntegrationEvent =
  | { type: "prompt-start" }
  | { type: "prompt-end" }
  | { type: "command-start"; command: string }
  | { type: "command-end"; exitCode: number }
  | { type: "cwd"; cwd: string };

export type ShellIntegrationSegment =
  | { type: "data"; data: string }
  | { type: "event"; event: ShellIntegrationEvent };

export interface ShellIntegrationParseResult {
  data: string;
  events: ShellIntegrationEvent[];
  segments: ShellIntegrationSegment[];
  mode: ShellIntegrationMode;
}

export interface ShellIntegrationParser {
  readonly mode: ShellIntegrationMode;
  push(data: string): ShellIntegrationParseResult;
  finish(): ShellIntegrationParseResult;
}

export interface ShellIntegrationParserOptions {
  maxFrameBytes?: number;
}

function assertValidNonce(nonce: string): void {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error(
      "Shell integration nonce must contain 16-128 URL-safe characters",
    );
  }
}

/** NUL is deliberately not encoded: shells cannot preserve it in variables,
 * and the decoder fails raw rather than materializing it as metadata. */
export function encodeShellIntegrationValue(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll(";", "%3B")
    .replaceAll("\x07", "%07")
    .replaceAll("\x1b", "%1B");
}

function decodeShellIntegrationValue(value: string): string | undefined {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "%") {
      decoded += value[index];
      continue;
    }
    const escape = value.slice(index, index + 3).toUpperCase();
    const replacement =
      escape === "%25"
        ? "%"
        : escape === "%3B"
          ? ";"
          : escape === "%07"
            ? "\x07"
            : escape === "%1B"
              ? "\x1b"
              : undefined;
    if (replacement === undefined) return undefined;
    decoded += replacement;
    index += 2;
  }
  return decoded.includes("\0") ? undefined : decoded;
}

function parseEvent(frameBody: string): ShellIntegrationEvent | undefined {
  const separator = frameBody.indexOf(";");
  const kind = separator === -1 ? frameBody : frameBody.slice(0, separator);
  const payload = separator === -1 ? undefined : frameBody.slice(separator + 1);

  if (kind === "A" && payload === undefined) return { type: "prompt-start" };
  if (kind === "B" && payload === undefined) return { type: "prompt-end" };
  if (kind === "C" && payload !== undefined) {
    const command = decodeShellIntegrationValue(payload);
    return command === undefined
      ? undefined
      : { type: "command-start", command };
  }
  if (
    kind === "D" &&
    payload !== undefined &&
    /^(?:0|[1-9]\d{0,2})$/.test(payload)
  ) {
    const exitCode = Number(payload);
    return exitCode <= 255 ? { type: "command-end", exitCode } : undefined;
  }
  if (kind === "P" && payload !== undefined) {
    const cwd = decodeShellIntegrationValue(payload);
    return cwd ? { type: "cwd", cwd } : undefined;
  }
  return undefined;
}

function terminatorAt(
  value: string,
  fromIndex: number,
): { index: number; length: number } | undefined {
  const bel = value.indexOf("\x07", fromIndex);
  const st = value.indexOf("\x1b\\", fromIndex);
  if (bel === -1 && st === -1) return undefined;
  if (bel !== -1 && (st === -1 || bel < st)) return { index: bel, length: 1 };
  return { index: st, length: 2 };
}

function appendDataSegment(
  segments: ShellIntegrationSegment[],
  data: string,
): void {
  if (!data) return;
  const last = segments.at(-1);
  if (last?.type === "data") {
    last.data += data;
  } else {
    segments.push({ type: "data", data });
  }
}

function potentialPrefixLength(value: string, prefix: string): number {
  const max = Math.min(value.length, prefix.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (prefix.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

class NonceScopedShellIntegrationParser implements ShellIntegrationParser {
  private readonly prefix: string;
  private readonly maxFrameBytes: number;
  private pending = "";
  private currentMode: ShellIntegrationMode = "raw";

  constructor(nonce: string, options: ShellIntegrationParserOptions) {
    assertValidNonce(nonce);
    const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new Error("maxFrameBytes must be a positive safe integer");
    }
    this.prefix = `\x1b]${OSC_NAMESPACE};${nonce};`;
    this.maxFrameBytes = maxFrameBytes;
  }

  get mode(): ShellIntegrationMode {
    return this.currentMode;
  }

  push(data: string): ShellIntegrationParseResult {
    let input = this.pending + data;
    this.pending = "";
    let output = "";
    const events: ShellIntegrationEvent[] = [];
    const segments: ShellIntegrationSegment[] = [];

    while (input.length > 0) {
      const frameStart = input.indexOf(this.prefix);
      if (frameStart === -1) {
        const retainedLength = potentialPrefixLength(input, this.prefix);
        const data = input.slice(0, input.length - retainedLength);
        output += data;
        appendDataSegment(segments, data);
        this.pending = input.slice(input.length - retainedLength);
        break;
      }

      const beforeFrame = input.slice(0, frameStart);
      output += beforeFrame;
      appendDataSegment(segments, beforeFrame);
      input = input.slice(frameStart);
      const terminator = terminatorAt(input, this.prefix.length);
      if (!terminator) {
        if (Buffer.byteLength(input, "utf8") <= this.maxFrameBytes) {
          this.pending = input;
          break;
        }
        output += input[0];
        appendDataSegment(segments, input[0]);
        input = input.slice(1);
        continue;
      }

      const frameEnd = terminator.index + terminator.length;
      const frame = input.slice(0, frameEnd);
      const frameBody = input.slice(this.prefix.length, terminator.index);
      const event =
        Buffer.byteLength(frame, "utf8") <= this.maxFrameBytes
          ? parseEvent(frameBody)
          : undefined;
      if (event) {
        events.push(event);
        segments.push({ type: "event", event });
        this.currentMode = "integrated";
      } else {
        output += frame;
        appendDataSegment(segments, frame);
      }
      input = input.slice(frameEnd);
    }

    return { data: output, events, segments, mode: this.currentMode };
  }

  finish(): ShellIntegrationParseResult {
    const data = this.pending;
    this.pending = "";
    return {
      data,
      events: [],
      segments: data ? [{ type: "data", data }] : [],
      mode: this.currentMode,
    };
  }
}

class RawShellIntegrationParser implements ShellIntegrationParser {
  readonly mode = "raw" as const;

  push(data: string): ShellIntegrationParseResult {
    return {
      data,
      events: [],
      segments: data ? [{ type: "data", data }] : [],
      mode: this.mode,
    };
  }

  finish(): ShellIntegrationParseResult {
    return { data: "", events: [], segments: [], mode: this.mode };
  }
}

export function createShellIntegrationParser(
  nonce: string,
  options: ShellIntegrationParserOptions = {},
): ShellIntegrationParser {
  return new NonceScopedShellIntegrationParser(nonce, options);
}

export function createRawShellIntegrationParser(): ShellIntegrationParser {
  return new RawShellIntegrationParser();
}

function commonFunctions(nonce: string): string[] {
  return [
    `__agentlink_si_nonce='${nonce}'`,
    "__agentlink_si_active=0",
    "__agentlink_si_encode() {",
    "  local __agentlink_si_value=${1-}",
    "  __agentlink_si_value=${__agentlink_si_value//%/%25}",
    "  __agentlink_si_value=${__agentlink_si_value//;/%3B}",
    "  __agentlink_si_value=${__agentlink_si_value//$'\\033'/%1B}",
    "  __agentlink_si_value=${__agentlink_si_value//$'\\007'/%07}",
    "  __agentlink_si_encoded=$__agentlink_si_value",
    "}",
    "__agentlink_si_emit() {",
    "  local __agentlink_si_kind=$1",
    "  shift",
    `  printf '\\033]${OSC_NAMESPACE};%s;%s' "$__agentlink_si_nonce" "$__agentlink_si_kind"`,
    "  if (( $# > 0 )); then",
    '    __agentlink_si_encode "$1"',
    "    printf ';%s' \"$__agentlink_si_encoded\"",
    "  fi",
    "  printf '\\007'",
    "}",
  ];
}

function createZshIntegrationScript(nonce: string): string {
  return [
    ...commonFunctions(nonce),
    "__agentlink_si_precmd() {",
    "  local __agentlink_si_status=$?",
    "  if (( __agentlink_si_active )); then",
    '    __agentlink_si_emit D "$__agentlink_si_status"',
    "    __agentlink_si_active=0",
    "  fi",
    '  __agentlink_si_emit P "$PWD"',
    "  __agentlink_si_emit A",
    "}",
    "__agentlink_si_preexec() {",
    "  __agentlink_si_emit B",
    '  __agentlink_si_emit C "$1"',
    "  __agentlink_si_active=1",
    "}",
    "(( ${precmd_functions[(Ie)__agentlink_si_precmd]} )) || precmd_functions+=(__agentlink_si_precmd)",
    "(( ${preexec_functions[(Ie)__agentlink_si_preexec]} )) || preexec_functions+=(__agentlink_si_preexec)",
  ].join("\n");
}

function createBashIntegrationScript(nonce: string): string {
  return [
    'if [[ -z "$(trap -p DEBUG)" && $- != *T* ]]; then',
    ...commonFunctions(nonce).map((line) => `  ${line}`),
    "  __agentlink_si_prompting=0",
    "  __agentlink_si_prompt_begin() {",
    "    __agentlink_si_prompting=1",
    "    __agentlink_si_command_status=${__agentlink_si_last_status:-$?}",
    "    unset __agentlink_si_last_status",
    "  }",
    "  __agentlink_si_prompt_end() {",
    "    local __agentlink_si_status=$__agentlink_si_command_status",
    "    unset __agentlink_si_command_status",
    "    if (( __agentlink_si_active )); then",
    '      __agentlink_si_emit D "$__agentlink_si_status"',
    "      __agentlink_si_active=0",
    "    fi",
    '    __agentlink_si_emit P "$PWD"',
    "    __agentlink_si_emit A",
    "    __agentlink_si_prompting=0",
    "  }",
    "  __agentlink_si_preexec() {",
    "    local __agentlink_si_command=$1",
    "    local __agentlink_si_status=$2",
    '    if [[ "$__agentlink_si_command" == __agentlink_si_prompt_begin ]]; then',
    "      __agentlink_si_last_status=$__agentlink_si_status",
    "      return",
    "    fi",
    "    if (( __agentlink_si_prompting || __agentlink_si_active )); then",
    "      return",
    "    fi",
    "    __agentlink_si_emit B",
    '    __agentlink_si_emit C "$__agentlink_si_command"',
    "    __agentlink_si_active=1",
    "  }",
    '  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then',
    '    PROMPT_COMMAND=(__agentlink_si_prompt_begin "${PROMPT_COMMAND[@]}" __agentlink_si_prompt_end)',
    "  else",
    '    PROMPT_COMMAND="__agentlink_si_prompt_begin${PROMPT_COMMAND:+;${PROMPT_COMMAND}};__agentlink_si_prompt_end"',
    "  fi",
    '  trap \'__agentlink_si_preexec "$BASH_COMMAND" "$?"\' DEBUG',
    "fi",
  ].join("\n");
}

export function createShellIntegrationScript(
  shell: ShellIntegrationKind,
  nonce: string,
): string {
  assertValidNonce(nonce);
  return shell === "zsh"
    ? createZshIntegrationScript(nonce)
    : createBashIntegrationScript(nonce);
}
