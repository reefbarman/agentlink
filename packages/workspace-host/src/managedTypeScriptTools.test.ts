import type {
  HostTool,
  HostToolExecutionContext,
  HostToolResolveRequest,
} from "@agentlink/core";
import {
  createManagedTypeScriptTools,
  sanitizeManagedTypeScriptResult,
} from "./managedTypeScriptTools.js";
import { describe, expect, it, vi } from "vitest";

import type { ManagedTypeScriptService } from "./managedTypeScriptService.js";
import path from "node:path";
import { pathToFileURL } from "node:url";

const discovery: HostToolResolveRequest = {
  principal: { tenantId: "local", subjectId: "project" },
  sessionId: "session",
  turnId: "turn",
  input: { text: "inspect TypeScript", attachments: undefined },
};
const execution: HostToolExecutionContext = {
  principal: discovery.principal,
  sessionId: discovery.sessionId,
  turnId: discovery.turnId,
  model: {
    model: { providerId: "fixture", modelId: "fixture-model" },
    source: "turn",
  },
  signal: undefined,
};

function serviceFixture() {
  return {
    diagnostics: vi.fn(async () => ({
      state: "unavailable" as const,
      reason: "TypeScript intelligence is not installed",
      retryable: false,
    })),
    symbols: vi.fn(async () => ({
      state: "ready" as const,
      value: [{ name: "value", kind: 13 }],
      metadata: metadata(),
    })),
    definition: vi.fn(async () => ({
      state: "ready" as const,
      value: {
        uri: pathToFileURL(path.join(process.cwd(), "package.json")).href,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
      },
      metadata: metadata(),
    })),
    references: vi.fn(async () => ({
      state: "ready" as const,
      value: [],
      metadata: metadata(),
    })),
    hover: vi.fn(async () => ({
      state: "ready" as const,
      value: { contents: "const value: string" },
      metadata: metadata(),
    })),
  };
}

function metadata() {
  return {
    provider: "typescript-language-server" as const,
    serverVersion: "5.3.0",
    typescriptVersion: "5.9.3",
    positionEncoding: "utf-16" as const,
    projectRoot: process.cwd(),
    readiness: "ready" as const,
    coverage: "project" as const,
    documentVersion: 1,
    documentHash: "hash",
  };
}

function find(tools: readonly HostTool[], name: string): HostTool {
  const tool = tools.find((candidate) => candidate.definition.name === name);
  if (!tool) throw new Error(`Missing ${name}`);
  return tool;
}

function parse(result: Awaited<ReturnType<HostTool["execute"]>>) {
  if (typeof result.modelContent !== "string") throw new Error("Expected text");
  return JSON.parse(result.modelContent) as Record<string, unknown>;
}

describe("managed TypeScript tools", () => {
  it("exposes exactly five read-only capabilities and preserves unavailable state", async () => {
    const service = serviceFixture();
    const tools = await createManagedTypeScriptTools({
      projectRoot: process.cwd(),
      service: service as unknown as ManagedTypeScriptService,
    }).resolveTools(discovery);

    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "get_diagnostics",
      "get_symbols",
      "go_to_definition",
      "get_references",
      "get_hover",
    ]);
    expect(tools.every((tool) => tool.effect === "read")).toBe(true);
    expect(
      parse(
        await find(tools, "get_diagnostics").execute(
          { path: "package.json" },
          execution,
        ),
      ),
    ).toMatchObject({ state: "unavailable", retryable: false });
  });

  it("converts 1-indexed positions and rechecks file scope", async () => {
    const service = serviceFixture();
    const canReadPath = vi.fn(async () => true);
    const tools = await createManagedTypeScriptTools({
      projectRoot: process.cwd(),
      service: service as unknown as ManagedTypeScriptService,
      canReadPath,
    }).resolveTools(discovery);

    await find(tools, "get_hover").execute(
      { path: "package.json", line: 2, column: 4 },
      execution,
    );
    expect(canReadPath).toHaveBeenCalledWith(discovery, "package.json");
    expect(service.hover).toHaveBeenCalledWith(
      path.join(process.cwd(), "package.json"),
      { line: 1, character: 3 },
      undefined,
    );

    canReadPath.mockResolvedValue(false);
    const denied = await find(tools, "get_symbols").execute(
      { path: "package.json" },
      execution,
    );
    expect(denied.isError).toBe(true);
    expect(denied.modelContent).toBe("path_not_scoped");
  });

  it("sanitizes project paths and applies read scopes for context enrichment", async () => {
    const projectRoot = process.cwd();
    const projectUri = pathToFileURL(projectRoot).href.replace(/\/$/u, "");
    const result = await sanitizeManagedTypeScriptResult(
      {
        state: "ready",
        value: [
          {
            uri: pathToFileURL(path.join(projectRoot, "package.json")).href,
            detail: `${projectRoot}/package.json ${projectUri}/package.json`,
          },
          { uri: "file:///outside/dependency.ts", detail: "withheld" },
        ],
        metadata: metadata(),
      },
      projectRoot,
      async (relativePath) => relativePath === "package.json",
    );

    expect(result).toMatchObject({
      state: "ready",
      value: [
        {
          path: "package.json",
          detail: "./package.json ./package.json",
        },
      ],
      metadata: { projectRoot: "." },
      omittedLocations: 1,
    });
  });

  it("normalizes in-project locations and omits external source disclosure", async () => {
    const service = serviceFixture();
    const tools = await createManagedTypeScriptTools({
      projectRoot: process.cwd(),
      service: service as unknown as ManagedTypeScriptService,
    }).resolveTools(discovery);
    expect(
      parse(
        await find(tools, "go_to_definition").execute(
          { path: "package.json", line: 1, column: 1 },
          execution,
        ),
      ),
    ).toMatchObject({ value: { path: "package.json" } });

    service.definition.mockResolvedValue({
      state: "ready" as const,
      value: {
        uri: "file:///outside/dependency.ts",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
      },
      metadata: metadata(),
    });
    const external = await find(tools, "go_to_definition").execute(
      { path: "package.json", line: 1, column: 1 },
      execution,
    );
    expect(external.isError).not.toBe(true);
    expect(parse(external)).toMatchObject({
      value: null,
      omittedLocations: 1,
    });
  });
});
