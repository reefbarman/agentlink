import type * as Runtime from "./browserRuntime.js";

import { beforeAll, describe, expect, it } from "vitest";

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

let sdk: typeof Runtime;
beforeAll(async () => {
  const result = await build({
    entryPoints: [
      fileURLToPath(new URL("./browserRuntime.ts", import.meta.url)),
    ],
    platform: "browser",
    format: "iife",
    globalName: "sdk",
    bundle: true,
    write: false,
    metafile: true,
  });
  const context: Record<string, unknown> = {
    TextEncoder,
    AbortController,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    performance,
  };
  runInNewContext(result.outputFiles[0].text, context);
  sdk = context.sdk as typeof Runtime;
  expect(
    Object.keys(result.metafile?.inputs ?? {}).some((path) =>
      path.startsWith("node:"),
    ),
  ).toBe(false);
});
describe("browser runtime without Node globals", () => {
  it("runs a real multi-step loop and replays the exact assistant and tool messages", async () => {
    let calls = 0;
    const result = await sdk.runAgentToolLoop({
      execution: { limits: { maxModelCalls: 2, maxToolCalls: 1 } },
      callModel: async ({ iterationMessages }) => {
        calls += 1;
        if (calls === 1)
          return {
            text: "",
            toolCalls: [{ id: "lookup", name: "lookup_fixture", input: {} }],
            stopReason: "tool_use" as const,
          };
        expect(iterationMessages).toHaveLength(2);
        expect(iterationMessages[1].role).toBe("user");
        return {
          text: "Ready",
          toolCalls: [],
          stopReason: "end_turn" as const,
        };
      },
      runTool: async () => ({
        stop: false,
        content: "fixture",
        toolMessage: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "lookup", content: "fixture" },
          ],
        },
      }),
      finishSuccess: (text) => text,
      finishEmpty: () => "empty",
    });
    expect(result).toBe("Ready");
    expect(calls).toBe(2);
  });
  it("honours an already-cancelled turn and finite model limits", async () => {
    const controller = new AbortController();
    controller.abort();
    const handlers = {
      execution: { signal: controller.signal, limits: { maxModelCalls: 1 } },
      callModel: async () => ({ text: "", toolCalls: [] }),
      runTool: async () => ({ stop: true, content: "" }),
      finishSuccess: (text: string) => text,
      finishEmpty: () => "empty",
    };
    await expect(sdk.runAgentToolLoop(handlers)).rejects.toBeInstanceOf(
      sdk.TurnExecutionCancelledError,
    );
    await expect(
      sdk.runAgentToolLoop({
        ...handlers,
        execution: { limits: { maxModelCalls: 1 } },
        callModel: async () => ({
          text: "",
          toolCalls: [{ id: "one", name: "lookup", input: {} }],
        }),
        runTool: async () => ({ stop: false, content: "fixture" }),
      }),
    ).rejects.toBeInstanceOf(sdk.TurnExecutionLimitError);
  });
  it("translates requests and parses authoritative Responses completion without Buffer", async () => {
    const body = sdk.buildCodexStreamRequestBody({
      model: "gpt-5.6-sol",
      input: [],
      store: false,
    });
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    async function* events() {
      yield { type: "response.output_text.delta", delta: "Ready" };
      yield {
        type: "response.completed",
        response: {
          id: "fixture",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Ready" }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
    }
    const parsed = [];
    for await (const event of sdk.parseCodexResponseStreamEvents(
      events(),
      undefined,
      { includeTerminationEvidence: true, maxOutputBytes: 4096 },
    ))
      parsed.push(event);
    expect(
      parsed.some(
        (event) =>
          event.type === "model_stop" &&
          event.reason === "end_turn" &&
          event.terminationEvidence === "observed",
      ),
    ).toBe(true);
    expect(sdk.utf8ByteLength("é👗")).toBe(6);
  });
});
