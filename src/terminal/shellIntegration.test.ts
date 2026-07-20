import {
  createRawShellIntegrationParser,
  createShellIntegrationParser,
  createShellIntegrationScript,
  encodeShellIntegrationValue,
} from "./shellIntegration.js";
import { describe, expect, it } from "vitest";

const NONCE = "session_nonce_1234567890";

function frame(
  kind: string,
  payload?: string,
  terminator: "bel" | "st" = "bel",
): string {
  return `\x1b]697;AgentLink;${NONCE};${kind}${payload === undefined ? "" : `;${payload}`}${terminator === "bel" ? "\x07" : "\x1b\\"}`;
}

describe("shell integration protocol", () => {
  it("parses a complete prompt/command/cwd lifecycle and strips scoped frames", () => {
    const parser = createShellIntegrationParser(NONCE);
    const command = "printf 'a;b%'; echo \x1b[31mred\x07";
    const cwd = "/workspace/a;b%";

    const result = parser.push(
      [
        frame("P", encodeShellIntegrationValue(cwd)),
        frame("A"),
        "$ ",
        frame("B", undefined, "st"),
        frame("C", encodeShellIntegrationValue(command), "st"),
        "command output\r\n",
        frame("D", "7"),
        frame("P", encodeShellIntegrationValue("/workspace/next")),
        frame("A"),
      ].join(""),
    );

    expect(result).toEqual({
      data: "$ command output\r\n",
      events: [
        { type: "cwd", cwd },
        { type: "prompt-start" },
        { type: "prompt-end" },
        { type: "command-start", command },
        { type: "command-end", exitCode: 7 },
        { type: "cwd", cwd: "/workspace/next" },
        { type: "prompt-start" },
      ],
      segments: [
        { type: "event", event: { type: "cwd", cwd } },
        { type: "event", event: { type: "prompt-start" } },
        { type: "data", data: "$ " },
        { type: "event", event: { type: "prompt-end" } },
        { type: "event", event: { type: "command-start", command } },
        { type: "data", data: "command output\r\n" },
        { type: "event", event: { type: "command-end", exitCode: 7 } },
        {
          type: "event",
          event: { type: "cwd", cwd: "/workspace/next" },
        },
        { type: "event", event: { type: "prompt-start" } },
      ],
      mode: "integrated",
    });
    expect(parser.mode).toBe("integrated");
  });

  it("parses frames split across arbitrary chunks and both terminators", () => {
    const parser = createShellIntegrationParser(NONCE);
    const encoded = frame("C", encodeShellIntegrationValue("echo hello"), "st");
    const chunks = [
      `before${encoded.slice(0, 1)}`,
      encoded.slice(1, 10),
      encoded.slice(10, -1),
      `${encoded.slice(-1)}after`,
    ];

    const results = chunks.map((chunk) => parser.push(chunk));

    expect(results.map((result) => result.data).join("")).toBe("beforeafter");
    expect(results.flatMap((result) => result.events)).toEqual([
      { type: "command-start", command: "echo hello" },
    ]);
  });

  it("passes foreign, malformed, unknown, and out-of-range frames through raw", () => {
    const parser = createShellIntegrationParser(NONCE);
    const foreign = `\x1b]697;AgentLink;different_nonce_123456;A\x07`;
    const malformedEscape = frame("C", "echo%20hello");
    const unknown = frame("Z", "value");
    const exitCode = frame("D", "256");
    const emptyCwd = frame("P", "");
    const input = `${foreign}${malformedEscape}${unknown}${exitCode}${emptyCwd}`;

    expect(parser.push(input)).toEqual({
      data: input,
      events: [],
      segments: [{ type: "data", data: input }],
      mode: "raw",
    });
    expect(parser.mode).toBe("raw");
  });

  it("flushes incomplete scoped frames as raw data when the stream ends", () => {
    const parser = createShellIntegrationParser(NONCE);
    const incomplete = frame("C", "echo").slice(0, -1);

    expect(parser.push(`output${incomplete}`)).toEqual({
      data: "output",
      events: [],
      segments: [{ type: "data", data: "output" }],
      mode: "raw",
    });
    expect(parser.finish()).toEqual({
      data: incomplete,
      events: [],
      segments: [{ type: "data", data: incomplete }],
      mode: "raw",
    });
    expect(parser.finish().data).toBe("");
  });

  it("does not buffer or interpret oversized scoped frames", () => {
    const parser = createShellIntegrationParser(NONCE, { maxFrameBytes: 64 });
    const oversized = frame("C", "x".repeat(80));

    const result = parser.push(oversized);

    expect(result.data).toBe(oversized);
    expect(result.events).toEqual([]);
    expect(result.mode).toBe("raw");
    expect(parser.finish().data).toBe("");
  });

  it("retains only a possible marker prefix between ordinary data chunks", () => {
    const parser = createShellIntegrationParser(NONCE);

    expect(parser.push("ordinary\x1b")).toMatchObject({
      data: "ordinary",
      events: [],
    });
    expect(parser.push("[31mred")).toMatchObject({
      data: "\x1b[31mred",
      events: [],
    });
    expect(parser.push("tail\x1b]697")).toMatchObject({
      data: "tail",
      events: [],
    });
    expect(parser.finish().data).toBe("\x1b]697");
  });

  it("decodes only protocol escapes and rejects decoded NUL values", () => {
    const parser = createShellIntegrationParser(NONCE);
    const valid = frame("C", "100%25%3Bdone");
    const nul = frame("C", "bad\0command");

    const result = parser.push(`${valid}${nul}`);

    expect(result.events).toEqual([
      { type: "command-start", command: "100%;done" },
    ]);
    expect(result.data).toBe(nul);
  });

  it("provides a zero-buffer raw-stream degraded mode", () => {
    const parser = createRawShellIntegrationParser();
    const markerLike = frame("A");

    expect(parser.push(`one${markerLike}`)).toEqual({
      data: `one${markerLike}`,
      events: [],
      segments: [{ type: "data", data: `one${markerLike}` }],
      mode: "raw",
    });
    expect(parser.push("two")).toEqual({
      data: "two",
      events: [],
      segments: [{ type: "data", data: "two" }],
      mode: "raw",
    });
    expect(parser.finish()).toEqual({
      data: "",
      events: [],
      segments: [],
      mode: "raw",
    });
  });

  it("rejects unsafe nonces and invalid frame limits", () => {
    expect(() => createShellIntegrationParser("short")).toThrow(
      "Shell integration nonce must contain 16-128 URL-safe characters",
    );
    expect(() =>
      createShellIntegrationScript("zsh", "bad;nonce-value!!"),
    ).toThrow(
      "Shell integration nonce must contain 16-128 URL-safe characters",
    );
    expect(() =>
      createShellIntegrationParser(NONCE, { maxFrameBytes: 0 }),
    ).toThrow("maxFrameBytes must be a positive safe integer");
  });
});

describe("shell integration hook generation", () => {
  it("generates nonce-scoped zsh precmd/preexec hooks", () => {
    const script = createShellIntegrationScript("zsh", NONCE);

    expect(script).toContain(`__agentlink_si_nonce='${NONCE}'`);
    expect(script).toContain("__agentlink_si_precmd() {");
    expect(script).toContain("__agentlink_si_preexec() {");
    expect(script).toContain("precmd_functions+=(__agentlink_si_precmd)");
    expect(script).toContain("preexec_functions+=(__agentlink_si_preexec)");
    expect(script).toContain('__agentlink_si_emit C "$1"');
    expect(script).toContain('__agentlink_si_emit P "$PWD"');
    expect(script).toContain("__agentlink_si_emit D");
  });

  it("generates guarded bash prompt lifecycle and DEBUG hooks", () => {
    const script = createShellIntegrationScript("bash", NONCE);

    expect(script).toContain(
      'if [[ -z "$(trap -p DEBUG)" && $- != *T* ]]; then',
    );
    expect(script).toContain("__agentlink_si_prompt_begin() {");
    expect(script).toContain("__agentlink_si_prompt_end() {");
    expect(script).toContain("__agentlink_si_preexec() {");
    expect(script).toContain(
      "__agentlink_si_command_status=${__agentlink_si_last_status:-$?}",
    );
    expect(script).toContain(
      '[[ "$__agentlink_si_command" == __agentlink_si_prompt_begin ]]',
    );
    expect(script).toContain(
      "__agentlink_si_last_status=$__agentlink_si_status",
    );
    expect(script).toContain(
      'trap \'__agentlink_si_preexec "$BASH_COMMAND" "$?"\' DEBUG',
    );
  });

  it("wraps scalar and array PROMPT_COMMAND values inside a suppression window", () => {
    const script = createShellIntegrationScript("bash", NONCE);

    expect(script).toContain(
      '[[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]',
    );
    expect(script).toContain(
      'PROMPT_COMMAND=(__agentlink_si_prompt_begin "${PROMPT_COMMAND[@]}" __agentlink_si_prompt_end)',
    );
    expect(script).toContain(
      'PROMPT_COMMAND="__agentlink_si_prompt_begin${PROMPT_COMMAND:+;${PROMPT_COMMAND}};__agentlink_si_prompt_end"',
    );
    expect(script.indexOf("__agentlink_si_prompting=1")).toBeLessThan(
      script.indexOf("__agentlink_si_command_status="),
    );
    expect(script.lastIndexOf("__agentlink_si_prompting=0")).toBeGreaterThan(
      script.indexOf("__agentlink_si_emit A"),
    );
  });

  it("uses shell built-ins and escapes protocol delimiters", () => {
    for (const shell of ["zsh", "bash"] as const) {
      const script = createShellIntegrationScript(shell, NONCE);
      expect(script).toContain("printf");
      expect(script).toContain("697;AgentLink;%s;%s");
      expect(script).toContain("${__agentlink_si_value//%/%25}");
      expect(script).toContain("${__agentlink_si_value//;/%3B}");
      expect(script).not.toMatch(/\b(?:base64|perl|python|sed|tr)\b/);
    }
  });
});
