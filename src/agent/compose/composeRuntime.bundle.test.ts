import * as path from "node:path";

import {
  COMPOSE_MAX_FINAL_BYTES,
  COMPOSE_MAX_RECOVERY_PREVIEW_BYTES,
  type ComposeParams,
  type ComposeRuntimeOptions,
  type ComposeToolResult,
} from "./composeRuntime.js";
import { beforeAll, describe, expect, it } from "vitest";

import type { ComposeExecutionScope } from "./composeScope.js";
import { execFile } from "node:child_process";
import { loadComposeRuntime } from "./composeRuntimeLoader.js";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

interface BundledComposeRuntime {
  handleCompose(options: ComposeRuntimeOptions): Promise<ComposeToolResult>;
}

const execFileAsync = promisify(execFile);
let runtime: BundledComposeRuntime;

beforeAll(async () => {
  await execFileAsync(process.execPath, ["esbuild.mjs"], {
    cwd: path.resolve("."),
    env: { ...process.env, DEV_BUILD: "true" },
  });
  runtime = (await loadComposeRuntime(
    path.resolve("."),
  )) as BundledComposeRuntime;
}, 120_000);

function runBundledCompose(
  params: ComposeParams,
  scope: ComposeExecutionScope = {
    canExecuteChild: () => false,
    preflightChild: () => {
      throw new Error("No child calls expected");
    },
    reserveChildren: () => undefined,
    executeChild: async () => {
      throw new Error("No child calls expected");
    },
  },
): Promise<ComposeToolResult> {
  return runtime.handleCompose({
    params,
    scope,
    signal: new AbortController().signal,
    wasmPath: require.resolve("@jitl/quickjs-wasmfile-release-asyncify/wasm"),
  });
}

describe("bundled compose runtime", () => {
  it("keeps QuickJS out of the CommonJS extension bundle", async () => {
    const extensionBundle = await readFile(
      path.resolve("dist/extension.js"),
      "utf8",
    );

    expect(extensionBundle).toContain("compose-runtime.mjs");
    expect(extensionBundle).not.toContain(
      "newQuickJSAsyncWASMModuleFromVariant",
    );
    expect(extensionBundle).not.toContain("quickjs-emscripten-core");
    expect(extensionBundle).not.toContain(
      "@jitl/quickjs-wasmfile-release-asyncify",
    );
  });

  it("initializes QuickJS from the Node ESM bundle", async () => {
    const result = await runBundledCompose({
      script: 'return { value: 42, text: "ok" };',
      description: "bundle smoke",
    });

    expect(result.isError).toBe(false);
    expect(result.data).toEqual({ value: 42, text: "ok" });
  });

  it("retains exact oversized results through the bundled runtime callback", async () => {
    let retainedContent = "";
    const scope: ComposeExecutionScope = {
      canExecuteChild: (name) => name === "lookup",
      preflightChild: () => undefined,
      reserveChildren: () => undefined,
      executeChild: async () => {
        const data = "x".repeat(COMPOSE_MAX_FINAL_BYTES / 2);
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          data,
          isError: false,
        };
      },
    };
    const params = {
      script:
        'const value = tool("lookup", {}); return { value, duplicate: value };',
      description: "bundle oversized recovery smoke",
    };
    const result = await runtime.handleCompose({
      params,
      scope,
      signal: new AbortController().signal,
      wasmPath: require.resolve("@jitl/quickjs-wasmfile-release-asyncify/wasm"),
      retainArtifact: async (request) => {
        retainedContent = request.content;
        return {
          path: "/tmp/bundled-compose-result.jsonl",
          bytes: Buffer.byteLength(request.content),
          chars: [...request.content].length,
          sha256: "artifact-sha",
        };
      },
    });

    expect(result).toMatchObject({
      isError: true,
      error: { kind: "serialization" },
      uiMeta: {
        composeTrace: {
          status: "error",
          totalChildren: 1,
          completedChildren: 1,
        },
      },
    });
    const recovery = (result.data as { recovery: Record<string, unknown> })
      .recovery;
    expect(recovery).toMatchObject({
      reason: "final_result_too_large",
      limit_bytes: COMPOSE_MAX_FINAL_BYTES,
      preview_truncated: true,
      children: [{ name: "lookup", status: "completed" }],
      output_file: "/tmp/bundled-compose-result.jsonl",
      output_format: "chunked-json-v1",
    });
    expect(recovery.preview_bytes).toBeLessThanOrEqual(
      COMPOSE_MAX_RECOVERY_PREVIEW_BYTES,
    );
    const reconstructed = retainedContent
      .trimEnd()
      .split("\n")
      .map((line) => (JSON.parse(line) as { data: string }).data)
      .join("");
    expect(JSON.parse(reconstructed)).toEqual({
      value: "x".repeat(COMPOSE_MAX_FINAL_BYTES / 2),
      duplicate: "x".repeat(COMPOSE_MAX_FINAL_BYTES / 2),
    });
  });

  it("bridges child tool calls from the bundle", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const result = await runBundledCompose(
      {
        script: 'return tool("lookup", { query: "compose" });',
        description: "bundle bridge smoke",
      },
      {
        canExecuteChild: (name) => name === "lookup",
        preflightChild: () => undefined,
        reserveChildren: () => undefined,
        executeChild: async (name, input) => {
          calls.push([name, input]);
          const data = { matches: 3 };
          return {
            content: [{ type: "text", text: JSON.stringify(data) }],
            data,
            isError: false,
          };
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(result.data).toEqual({ matches: 3 });
    expect(calls).toEqual([["lookup", { query: "compose" }]]);
  });
});
