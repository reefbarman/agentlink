import * as path from "node:path";

import type {
  ComposeParams,
  ComposeRuntimeOptions,
  ComposeToolResult,
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
  });
  runtime = (await loadComposeRuntime(
    path.resolve("."),
  )) as BundledComposeRuntime;
}, 120_000);

function runBundledCompose(
  params: ComposeParams,
  scope: ComposeExecutionScope = {
    canExecuteChild: () => false,
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

  it("bridges child tool calls from the bundle", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const result = await runBundledCompose(
      {
        script: 'return tool("lookup", { query: "compose" });',
        description: "bundle bridge smoke",
      },
      {
        canExecuteChild: (name) => name === "lookup",
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
