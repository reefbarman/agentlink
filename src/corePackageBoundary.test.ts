import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { createRequire } from "node:module";

const ROOT = path.resolve(__dirname, "..");
const CORE_PACKAGE = path.join(ROOT, "packages", "core");
const CORE_SOURCE = path.join(CORE_PACKAGE, "src");
const requireFromBoundaryTest = createRequire(__filename);

const CORE_MODULES = [
  {
    exportPath: "agent-engine",
    fileName: "agentEngine",
    declarationDependencies: [
      "hostTools",
      "modelIdentity",
      "modelRuntime",
      "sessionRepository",
      "turnContracts",
      "turnExecution",
      "turnInteractions",
      "turnKernel",
      "turnLeases",
    ],
    identityExports: ["AgentEngineError", "createAgentEngine"],
    loadEsm: () => import("@agentlink/core/agent-engine"),
  },
  {
    exportPath: "agent-tool-loop",
    fileName: "agentToolLoop",
    declarationDependencies: ["modelRuntime", "turnExecution"],
    identityExports: ["runAgentToolLoop"],
    loadEsm: () => import("@agentlink/core/agent-tool-loop"),
  },
  {
    exportPath: "codex",
    fileName: "codex",
    declarationDependencies: [
      "codex/clientIdentity",
      "codex/completionFacade",
      "codex/errors",
      "codex/models",
      "codex/openaiClient",
      "codex/responsesStream",
      "codex/streamParser",
      "codex/translation",
    ],
    identityExports: [
      "CODEX_DEFAULT_MODEL",
      "CodexRequestError",
      "CodexStreamError",
      "collectCodexCompletionResult",
      "createOpenAiResponsesClient",
      "executeCodexResolvedCompletion",
      "executeCodexResponsesStream",
      "getCodexEndpointConfig",
      "getCodexModelCapabilities",
      "getCodexOriginator",
      "parseCodexResponseStreamEvents",
      "resolveCodexEffectiveModel",
    ],
    loadEsm: () => import("@agentlink/core/codex"),
  },
  {
    exportPath: "embedded-agent-web",
    fileName: "embeddedAgentWeb",
    declarationDependencies: ["agentEngine", "modelIdentity"],
    identityExports: [
      "createEmbeddedAgentWebHandler",
      "parseEmbeddedAgentRequest",
    ],
    loadEsm: () => import("@agentlink/core/embedded-agent-web"),
  },
  {
    exportPath: "host-adapter-contracts",
    fileName: "hostAdapterContracts",
    declarationDependencies: [
      "modelIdentity",
      "sessionRepository",
      "turnLeases",
    ],
    identityExports: [
      "runAgentSessionRepositoryContract",
      "runAgentTurnLeaseProviderContract",
    ],
    loadEsm: () => import("@agentlink/core/host-adapter-contracts"),
  },
  {
    exportPath: "host-approval-test-kit",
    fileName: "hostApprovalTestKit",
    declarationDependencies: [
      "modelIdentity",
      "modelRuntime",
      "sessionRepository",
      "turnInteractions",
      "turnLeases",
    ],
    identityExports: [
      "HostApprovalFixtureModelBackend",
      "runHostApprovalContract",
    ],
    loadEsm: () => import("@agentlink/core/host-approval-test-kit"),
  },
  {
    exportPath: "host-tools",
    fileName: "hostTools",
    declarationDependencies: ["modelIdentity", "modelRuntime", "turnContracts"],
    identityExports: [
      "HostToolInputValidationError",
      "defineTool",
      "defineZodTool",
      "formatHostToolValidationError",
    ],
    loadEsm: () => import("@agentlink/core/host-tools"),
  },
  {
    exportPath: "model-auth-provider",
    fileName: "modelAuthProvider",
    declarationDependencies: [],
    identityExports: [],
    loadEsm: () => import("@agentlink/core/model-auth-provider"),
  },
  {
    exportPath: "model-request-scheduler",
    fileName: "modelRequestScheduler",
    declarationDependencies: [],
    identityExports: ["ModelRequestScheduler"],
    loadEsm: () => import("@agentlink/core/model-request-scheduler"),
  },
  {
    exportPath: "model-runtime",
    fileName: "modelRuntime",
    declarationDependencies: ["modelAuthProvider", "modelIdentity"],
    identityExports: ["CoreModelBackendRegistry", "DefaultCoreModelRuntime"],
    loadEsm: () => import("@agentlink/core/model-runtime"),
  },
  {
    exportPath: "native-web-tools",
    fileName: "nativeWebTools",
    declarationDependencies: ["modelRuntime"],
    identityExports: [
      "appendNativeWebToolPreference",
      "collectNativeWebToolResult",
      "continueNativeWebProviderStream",
    ],
    loadEsm: () => import("@agentlink/core/native-web-tools"),
  },
  {
    exportPath: "openai-compatible",
    fileName: "openAiCompatible",
    declarationDependencies: ["openAiCompatible/index"],
    identityExports: [
      "OpenAiCompatibleBackend",
      "OpenAiCompatibleRequestError",
      "collectOpenAiCompatibleCompletion",
      "discoverOpenAiCompatibleModels",
      "normalizeOpenAiCompatibleConnections",
      "streamOpenAiCompatibleCompletion",
    ],
    loadEsm: () => import("@agentlink/core/openai-compatible"),
  },
  {
    exportPath: "provider-stream-watchdog",
    fileName: "providerStreamWatchdog",
    declarationDependencies: ["modelRuntime"],
    identityExports: [
      "ProviderStreamActivityMonitor",
      "ProviderStreamTimeoutError",
      "runWatchedProviderStream",
    ],
    loadEsm: () => import("@agentlink/core/provider-stream-watchdog"),
  },
  {
    exportPath: "session-repository",
    fileName: "sessionRepository",
    declarationDependencies: [
      "modelIdentity",
      "modelRuntime",
      "turnInteractions",
      "turnLeases",
    ],
    identityExports: ["InMemoryAgentStateRepository"],
    loadEsm: () => import("@agentlink/core/session-repository"),
  },
  {
    exportPath: "session-transcript-recall",
    fileName: "sessionTranscriptRecall",
    declarationDependencies: ["modelRuntime"],
    identityExports: [
      "formatSessionTranscriptRecallResult",
      "getSessionTranscriptRevision",
      "readSessionTranscriptExcerpt",
      "searchSessionTranscript",
    ],
    loadEsm: () => import("@agentlink/core/session-transcript-recall"),
  },
  {
    exportPath: "surface-model-messages",
    fileName: "surfaceModelMessages",
    declarationDependencies: ["modelRuntime"],
    identityExports: [
      "surfaceMessagesToCoreModelMessages",
      "surfaceMessageTextForModel",
    ],
    loadEsm: () => import("@agentlink/core/surface-model-messages"),
  },
  {
    exportPath: "tool-call-budget",
    fileName: "toolCallBudget",
    declarationDependencies: [],
    identityExports: ["ToolCallBudget"],
    loadEsm: () => import("@agentlink/core/tool-call-budget"),
  },
  {
    exportPath: "turn-contracts",
    fileName: "turnContracts",
    declarationDependencies: ["modelIdentity", "modelRuntime", "turnExecution"],
    identityExports: ["agentModelReferenceKey", "resolveAgentModelSelection"],
    loadEsm: () => import("@agentlink/core/turn-contracts"),
  },
  {
    exportPath: "turn-execution",
    fileName: "turnExecution",
    declarationDependencies: [],
    identityExports: [
      "TurnExecutionCancelledError",
      "TurnExecutionLimitError",
      "TurnExecutionTracker",
      "normalizeTurnExecutionLimits",
      "utf8ByteLength",
    ],
    loadEsm: () => import("@agentlink/core/turn-execution"),
  },
  {
    exportPath: "turn-interactions",
    fileName: "turnInteractions",
    declarationDependencies: [
      "agentToolLoop",
      "hostTools",
      "modelIdentity",
      "modelRuntime",
      "turnContracts",
      "turnExecution",
    ],
    identityExports: [
      "TurnInteractionResumeError",
      "TurnInteractionTokenError",
      "createTurnInteractionTokenService",
    ],
    loadEsm: () => import("@agentlink/core/turn-interactions"),
  },
  {
    exportPath: "turn-kernel",
    fileName: "turnKernel",
    declarationDependencies: [
      "hostTools",
      "modelIdentity",
      "modelRuntime",
      "turnContracts",
      "turnExecution",
      "turnInteractions",
    ],
    identityExports: [
      "DEFAULT_HEADLESS_TURN_LIMITS",
      "HEADLESS_TURN_SAFETY_SCAFFOLD",
      "buildHeadlessTurnSystemPrompt",
      "createHeadlessTurnKernel",
    ],
    loadEsm: () => import("@agentlink/core/turn-kernel"),
  },
  {
    exportPath: "turn-leases",
    fileName: "turnLeases",
    declarationDependencies: ["modelIdentity"],
    identityExports: [
      "InMemoryAgentTurnLeaseProvider",
      "compareTurnFencingTokens",
    ],
    loadEsm: () => import("@agentlink/core/turn-leases"),
  },
  {
    exportPath: "web-access",
    fileName: "webAccess",
    declarationDependencies: [],
    identityExports: [
      "createCoreProviderReplayEnvelope",
      "normalizeCoreWebAccessSettings",
      "resolveCoreWebAccessPolicy",
    ],
    loadEsm: () => import("@agentlink/core/web-access"),
  },
] as const;

const CORE_COMPATIBILITY_FACADES = [
  {
    path: "src/core/turnContracts.ts",
    exportPath: "@agentlink/core/turn-contracts",
    importerBaseline: [],
  },
  {
    path: "src/core/agentToolLoop.ts",
    exportPath: "@agentlink/core/agent-tool-loop",
    importerBaseline: [],
  },
  {
    path: "src/core/modelAuthProvider.ts",
    exportPath: "@agentlink/core/model-auth-provider",
    typeOnly: true,
    importerBaseline: ["src/agent/ChatViewProvider.ts"],
  },
  {
    path: "src/core/modelRequestScheduler.ts",
    exportPath: "@agentlink/core/model-request-scheduler",
    importerBaseline: [
      "src/agent/AgentEngine.ts",
      "src/agent/AgentSessionManager.ts",
      "src/core/modelRequestScheduler.test.ts",
      "src/extension.ts",
    ],
  },
  {
    path: "src/core/modelRuntime.ts",
    exportPath: "@agentlink/core/model-runtime",
    importerBaseline: [
      "src/agent/AgentEngine.test.ts",
      "src/agent/AgentEngine.ts",
      "src/agent/AgentSessionManager.ts",
      "src/agent/persistenceContracts.ts",
      "src/agent/types.ts",
    ],
  },
  {
    path: "src/core/nativeWebTools.ts",
    exportPath: "@agentlink/core/native-web-tools",
    importerBaseline: [
      "src/agent/AgentEngine.test.ts",
      "src/agent/AgentEngine.ts",
      "src/agent/AgentSessionManager.ts",
      "src/browser-gateway/helper/askAgentModelClient.ts",
      "src/browser-gateway/helper/browserGatewayHelper.ts",
      "src/core/nativeWebTools.test.ts",
    ],
  },
  {
    path: "src/core/model/providers/codex/models.ts",
    exportPath: "@agentlink/core/codex",
    importerBaseline: ["src/core/model/providers/codex/models.test.ts"],
  },
  {
    path: "src/agent/providers/codex/models.ts",
    exportPath: "@agentlink/core/codex",
    importerBaseline: ["src/agent/providers/codex/models.test.ts"],
  },
  {
    path: "src/core/model/providers/codex/clientIdentity.ts",
    exportPath: "@agentlink/core/codex",
    importerBaseline: ["src/core/model/providers/codex/clientIdentity.test.ts"],
  },
  {
    path: "src/core/model/providers/codex/completionFacade.ts",
    exportPath: "@agentlink/core/codex",
    importerBaseline: [
      "src/core/model/providers/codex/completionFacade.test.ts",
    ],
  },
  {
    path: "src/core/model/providers/codex/errors.ts",
    exportPath: "@agentlink/core/codex",
    importerBaseline: [
      "src/core/model/providers/codex/completionFacade.test.ts",
      "src/core/model/providers/codex/errors.test.ts",
    ],
  },
  {
    path: "src/core/model/providers/codex/openaiClient.ts",
    exportPath: "@agentlink/core/codex",
    importerBaseline: ["src/core/model/providers/codex/openaiClient.test.ts"],
  },
  {
    path: "src/agent/providers/codex/openaiClient.ts",
    exportPath: "@agentlink/core/codex",
    importerBaseline: [],
  },
  {
    path: "src/core/model/providers/codex/responsesStream.ts",
    exportPath: "@agentlink/core/codex",
    importerBaseline: [
      "src/core/model/providers/codex/responsesStream.test.ts",
    ],
  },
  {
    path: "src/core/model/providers/codex/streamParser.ts",
    exportPath: "@agentlink/core/codex",
    importerBaseline: ["src/core/model/providers/codex/streamParser.test.ts"],
  },
  {
    path: "src/core/model/providers/codex/translation.ts",
    exportPath: "@agentlink/core/codex",
    importerBaseline: ["src/core/model/providers/codex/translation.test.ts"],
  },
  {
    path: "src/core/model/providers/openaiCompatible/completionFacade.ts",
    exportPath: "@agentlink/core/openai-compatible",
    importerBaseline: [],
  },
  {
    path: "src/core/model/providers/openaiCompatible/errors.ts",
    exportPath: "@agentlink/core/openai-compatible",
    importerBaseline: ["src/agent/AgentEngine.test.ts"],
  },
  {
    path: "src/core/model/providers/openaiCompatible/index.ts",
    exportPath: "@agentlink/core/openai-compatible",
    importerBaseline: ["src/browser-gateway/helper/askAgentModelClient.ts"],
  },
  {
    path: "src/core/model/providers/openaiCompatible/sse.ts",
    exportPath: "@agentlink/core/openai-compatible",
    importerBaseline: [],
  },
  {
    path: "src/core/model/providers/openaiCompatible/streamParser.ts",
    exportPath: "@agentlink/core/openai-compatible",
    importerBaseline: [],
  },
  {
    path: "src/core/model/providers/openaiCompatible/translation.ts",
    exportPath: "@agentlink/core/openai-compatible",
    importerBaseline: [],
  },
  {
    path: "src/core/model/providers/openaiCompatible/types.ts",
    exportPath: "@agentlink/core/openai-compatible",
    importerBaseline: ["src/browser-gateway/helper/browserGatewayHelper.ts"],
  },
  {
    path: "src/agent/providers/openaiCompatible/config.ts",
    exportPath: "@agentlink/core/openai-compatible",
    importerBaseline: [
      "src/agent/providers/openaiCompatible/OpenAiCompatibleProvider.ts",
      "src/agent/providers/openaiCompatible/index.ts",
    ],
  },
  {
    path: "src/agent/providers/openaiCompatible/modelDiscovery.ts",
    exportPath: "@agentlink/core/openai-compatible",
    importerBaseline: ["src/extension.ts"],
  },
  {
    path: "src/core/providerStreamWatchdog.ts",
    exportPath: "@agentlink/core/provider-stream-watchdog",
    importerBaseline: [
      "src/agent/AgentEngine.ts",
      "src/agent/AgentSessionManager.ts",
    ],
  },
  {
    path: "src/core/sessionTranscriptRecall.ts",
    exportPath: "@agentlink/core/session-transcript-recall",
    importerBaseline: [
      "src/agent/AgentEngine.ts",
      "src/agent/AgentSessionManager.ts",
      "src/core/sessionTranscriptRecall.test.ts",
      "src/core/tools/types.ts",
      "src/tools/sessionTranscriptRecall.ts",
    ],
  },
  {
    path: "src/core/surfaceModelMessages.ts",
    exportPath: "@agentlink/core/surface-model-messages",
    importerBaseline: [
      "src/browser-gateway/browserGatewayAskAgentSessionStore.ts",
      "src/browser-gateway/helper/askAgentModelClient.ts",
      "src/core/surfaceModelMessages.test.ts",
    ],
  },
  {
    path: "src/core/tools/toolCallBudget.ts",
    exportPath: "@agentlink/core/tool-call-budget",
    importerBaseline: [
      "src/agent/AgentEngine.ts",
      "src/agent/toolAdapter.test.ts",
    ],
  },
  {
    path: "src/core/webAccess.ts",
    exportPath: "@agentlink/core/web-access",
    importerBaseline: [
      "src/agent/AgentSessionManager.ts",
      "src/agent/toolAdapter.ts",
      "src/browser-gateway/browserGatewayAskAgentHistory.ts",
      "src/browser-gateway/helper/browserGatewayHelper.ts",
      "src/core/model/providers/openaiCompatible/streamParser.ts",
      "src/core/model/providers/openaiCompatible/translation.test.ts",
      "src/core/webAccess.test.ts",
    ],
  },
] as const;

function walkTypeScriptFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkTypeScriptFiles(filePath));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(filePath);
  }
  return files;
}

function importedModules(
  sourceFile: string,
  source: string,
): ReadonlySet<string> {
  const staticSpecifiers = [
    ...source.matchAll(
      /^\s*(?:import|export)\b(?:(?!^\s*(?:import|export)\b)[\s\S])*?\bfrom\s*["']([^"']+?)(?:\.js)?["']/gm,
    ),
  ];
  const sideEffectSpecifiers = [
    ...source.matchAll(/^\s*import\s*["']([^"']+?)(?:\.js)?["']/gm),
  ];
  return new Set(
    [...staticSpecifiers, ...sideEffectSpecifiers].map((match) => {
      const specifier = (match[1] ?? "").replace(/\.js$/, "");
      return specifier.startsWith(".")
        ? path.resolve(path.dirname(sourceFile), specifier)
        : specifier;
    }),
  );
}

describe("core package boundary", () => {
  it("keeps production core package modules independent from root source and product surfaces", () => {
    const violations: string[] = [];
    for (const filePath of walkTypeScriptFiles(CORE_SOURCE)) {
      if (filePath.endsWith(".test.ts")) continue;
      const source = fs.readFileSync(filePath, "utf8");
      if (/from\s+["']vscode["']/.test(source)) {
        violations.push(`${path.relative(ROOT, filePath)}: imports VS Code`);
      }
      if (/from\s+["'][^"']*(?:^|\/)src\//.test(source)) {
        violations.push(`${path.relative(ROOT, filePath)}: imports root src`);
      }
      if (/from\s+["'][^"']*(?:agent|browser-gateway|webview)\//.test(source)) {
        violations.push(
          `${path.relative(ROOT, filePath)}: imports a product surface`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it("wires every curated core module through all package surfaces", async () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(CORE_PACKAGE, "package.json"), "utf8"),
    ) as {
      exports?: Record<
        string,
        {
          browser?: unknown;
          edge?: unknown;
          import?: unknown;
          require?: unknown;
        }
      >;
    };
    const indexSource = fs.readFileSync(
      path.join(CORE_SOURCE, "index.ts"),
      "utf8",
    );
    const buildScripts = ["build-cjs.mjs", "watch.mjs"].map((fileName) => ({
      fileName,
      source: fs.readFileSync(path.join(CORE_PACKAGE, fileName), "utf8"),
    }));

    const cjsRoot = requireFromBoundaryTest("@agentlink/core") as Record<
      string,
      unknown
    >;
    expect(manifest.exports?.["."]).toMatchObject({
      browser: null,
      edge: null,
    });
    for (const module of CORE_MODULES) {
      expect(manifest.exports?.[`./${module.exportPath}`]).toEqual({
        browser: null,
        edge: null,
        import: {
          types: `./dist/${module.fileName}.d.ts`,
          default: `./dist/${module.fileName}.js`,
        },
        require: {
          types: `./dist/cjs/${module.fileName}.d.cts`,
          default: `./dist/cjs/${module.fileName}.cjs`,
        },
      });
      expect(indexSource).toContain(`export * from "./${module.fileName}.js";`);
      for (const buildScript of buildScripts) {
        if (buildScript.fileName === "build-cjs.mjs") {
          expect(buildScript.source).toContain(`"${module.fileName}"`);
          expect(buildScript.source).toContain(
            "modules.map((module) => `src/${module}.ts`)",
          );
        } else {
          expect(buildScript.source).toContain(`"src/${module.fileName}.ts"`);
        }
      }
      for (const filePath of [
        `dist/${module.fileName}.js`,
        `dist/${module.fileName}.d.ts`,
        `dist/cjs/${module.fileName}.cjs`,
        `dist/cjs/${module.fileName}.d.cts`,
        `dist/cjs/${module.fileName}.d.cts.map`,
      ]) {
        expect(fs.existsSync(path.join(CORE_PACKAGE, filePath)), filePath).toBe(
          true,
        );
      }

      const declaration = fs.readFileSync(
        path.join(CORE_PACKAGE, "dist", "cjs", `${module.fileName}.d.cts`),
        "utf8",
      );
      for (const dependency of module.declarationDependencies) {
        expect(declaration).toContain(`from "./${dependency}.cjs"`);
      }
      expect(declaration).toContain(
        `//# sourceMappingURL=${module.fileName}.d.cts.map`,
      );
      const declarationMap = JSON.parse(
        fs.readFileSync(
          path.join(
            CORE_PACKAGE,
            "dist",
            "cjs",
            `${module.fileName}.d.cts.map`,
          ),
          "utf8",
        ),
      ) as { file?: string; sources?: string[] };
      expect(declarationMap.file).toBe(`${module.fileName}.d.cts`);
      for (const source of declarationMap.sources ?? []) {
        expect(
          fs.existsSync(path.resolve(CORE_PACKAGE, "dist", "cjs", source)),
          `${module.fileName}:${source}`,
        ).toBe(true);
      }

      await expect(module.loadEsm()).resolves.toBeTypeOf("object");
      const cjsSubpath = requireFromBoundaryTest(
        `@agentlink/core/${module.exportPath}`,
      ) as Record<string, unknown>;
      for (const exportName of module.identityExports) {
        expect(cjsRoot[exportName], `${module.exportPath}:${exportName}`).toBe(
          cjsSubpath[exportName],
        );
      }
    }

    const cjsSurfaceModelMessagesSource = fs.readFileSync(
      path.join(CORE_PACKAGE, "dist/cjs/surfaceModelMessages.cjs"),
      "utf8",
    );
    expect(cjsSurfaceModelMessagesSource).toContain(
      'require("./modelRuntime.cjs")',
    );
    expect(cjsSurfaceModelMessagesSource).not.toContain(
      "class CoreModelBackendRegistry",
    );

    for (const module of [
      "clientIdentity",
      "completionFacade",
      "errors",
      "models",
      "openaiClient",
      "responsesStream",
      "streamParser",
      "translation",
    ]) {
      for (const suffix of ["d.cts", "d.cts.map"]) {
        const filePath = `dist/cjs/codex/${module}.${suffix}`;
        expect(fs.existsSync(path.join(CORE_PACKAGE, filePath)), filePath).toBe(
          true,
        );
      }
      const declarationMap = JSON.parse(
        fs.readFileSync(
          path.join(CORE_PACKAGE, "dist/cjs/codex", `${module}.d.cts.map`),
          "utf8",
        ),
      ) as { sources?: string[] };
      for (const source of declarationMap.sources ?? []) {
        expect(
          fs.existsSync(path.resolve(CORE_PACKAGE, "dist/cjs/codex", source)),
          `codex/${module}:${source}`,
        ).toBe(true);
      }
    }

    for (const module of [
      "backend",
      "completionFacade",
      "config",
      "errors",
      "index",
      "modelDiscovery",
      "sse",
      "streamParser",
      "translation",
      "types",
    ]) {
      for (const suffix of ["d.cts", "d.cts.map"]) {
        const filePath = `dist/cjs/openAiCompatible/${module}.${suffix}`;
        expect(fs.existsSync(path.join(CORE_PACKAGE, filePath)), filePath).toBe(
          true,
        );
      }
      const declarationMap = JSON.parse(
        fs.readFileSync(
          path.join(
            CORE_PACKAGE,
            "dist/cjs/openAiCompatible",
            `${module}.d.cts.map`,
          ),
          "utf8",
        ),
      ) as { sources?: string[] };
      for (const source of declarationMap.sources ?? []) {
        expect(
          fs.existsSync(
            path.resolve(CORE_PACKAGE, "dist/cjs/openAiCompatible", source),
          ),
          `openAiCompatible/${module}:${source}`,
        ).toBe(true);
      }
    }
  });

  it("keeps core compatibility facades package-owned with bounded importers", () => {
    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        imports: importedModules(filePath, fs.readFileSync(filePath, "utf8")),
      }),
    );
    for (const facade of CORE_COMPATIBILITY_FACADES) {
      const compatibilityPath = path.join(ROOT, facade.path);
      const expected =
        "typeOnly" in facade && facade.typeOnly
          ? `export type { CoreModelAuthProvider } from "${facade.exportPath}";\n`
          : `export * from "${facade.exportPath}";\n`;
      expect(fs.readFileSync(compatibilityPath, "utf8"), facade.path).toBe(
        expected,
      );

      const compatibilityModule = compatibilityPath.replace(/\.ts$/, "");
      const importers = sourceFiles
        .filter(({ filePath }) => filePath !== compatibilityPath)
        .filter(
          ({ imports }) =>
            imports.has(compatibilityModule) ||
            imports.has(path.relative(ROOT, compatibilityModule)),
        )
        .map(({ filePath }) => path.relative(ROOT, filePath))
        .sort();
      const importerBaseline = new Set<string>(facade.importerBaseline);
      expect(
        importers.every((importer) => importerBaseline.has(importer)),
        facade.path,
      ).toBe(true);
      expect(importers.length, facade.path).toBeLessThanOrEqual(
        importerBaseline.size,
      );
    }
  });
});
