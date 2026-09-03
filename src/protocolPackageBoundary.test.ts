import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { build } from "esbuild";
import { createRequire } from "node:module";

const ROOT = path.resolve(__dirname, "..");
const PROTOCOL_SOURCE = path.join(ROOT, "packages", "protocol", "src");
const requireFromBoundaryTest = createRequire(__filename);
const typescriptAst = import("typescript/unstable/ast");
const LEGACY_SHIMS = [
  {
    path: "src/core/sessionProtocol.ts",
    exportPath: "@agentlink/protocol/session",
    allowedImporter: "src/core/sessionProtocol.test.ts",
    importPattern: /from\s+["'][^"']*sessionProtocol(?:\.js)?["']/,
  },
  {
    path: "src/agent/chatTabProtocol.ts",
    exportPath: "@agentlink/protocol/chat-workspace",
    allowedImporter: "src/agent/chatTabProtocol.test.ts",
    importPattern: /from\s+["'][^"']*chatTabProtocol(?:\.js)?["']/,
  },

  {
    path: "src/shared/composeTypes.ts",
    exportPath: "@agentlink/protocol/compose",
    allowedImporter: "src/shared/composeTypes.test.ts",
    importPattern: /from\s+["'][^"']*composeTypes(?:\.js)?["']/,
  },
  {
    path: "src/shared/agentPluginManagerTypes.ts",
    exportPath: "@agentlink/protocol/agent-plugin-manager",
    allowedImporter: "src/shared/agentPluginManagerTypes.test.ts",
    importPattern: /from\s+["'][^"']*agentPluginManagerTypes(?:\.js)?["']/,
  },
  {
    path: "src/shared/mcpManagerTypes.ts",
    exportPath: "@agentlink/protocol/mcp-manager",
    allowedImporter: "src/shared/mcpManagerTypes.test.ts",
    importPattern: /from\s+["'][^"']*mcpManagerTypes(?:\.js)?["']/,
  },
  {
    path: "src/shared/modelSetup.ts",
    exportPath: "@agentlink/protocol/model-setup",
    allowedImporter: "src/shared/modelSetup.test.ts",
    importPattern: /from\s+["'][^"']*modelSetup(?:\.js)?["']/,
  },
  {
    path: "src/shared/mcpElicitation.ts",
    exportPath: "@agentlink/protocol/mcp-elicitation",
    allowedImporter: "src/shared/mcpElicitation.test.ts",
    importPattern: /from\s+["'][^"']*mcpElicitation(?:\.js)?["']/,
  },
  {
    path: "src/shared/mcpUrlElicitation.ts",
    exportPath: "@agentlink/protocol/mcp-url-elicitation",
    allowedImporter: "src/shared/mcpUrlElicitation.test.ts",
    importPattern: /from\s+["'][^"']*mcpUrlElicitation(?:\.js)?["']/,
  },
  {
    path: "src/shared/questionConfirmation.ts",
    exportPath: "@agentlink/protocol/question-confirmation",
    allowedImporter: "src/shared/questionConfirmation.test.ts",
    importPattern: /from\s+["'][^"']*questionConfirmation(?:\.js)?["']/,
  },
  {
    path: "src/shared/finalStatus.ts",
    exportPath: "@agentlink/protocol/final-status",
    allowedImporter: "src/shared/finalStatus.test.ts",
    importPattern: /from\s+["'][^"']*finalStatus(?:\.js)?["']/,
  },
  {
    path: "src/shared/autoContinueProgress.ts",
    exportPath: "@agentlink/protocol/auto-continue-progress",
    allowedImporter: "src/shared/autoContinueProgress.test.ts",
    importPattern: /from\s+["'][^"']*autoContinueProgress(?:\.js)?["']/,
  },
  {
    path: "src/shared/todoContinuation.ts",
    exportPath: "@agentlink/protocol/todo-continuation",
    allowedImporter: "src/shared/todoContinuation.test.ts",
    importPattern: /from\s+["'][^"']*todoContinuation(?:\.js)?["']/,
  },
  {
    path: "src/approvals/commandApprovalPolicy.ts",
    exportPath: "@agentlink/protocol/command-approval-policy",
    allowedImporter: "src/approvals/commandApprovalPolicy.test.ts",
    importPattern: /from\s+["'][^"']*commandApprovalPolicy(?:\.js)?["']/,
  },
  {
    path: "src/shared/contextHealth.ts",
    exportPath: "@agentlink/protocol/context-health",
    allowedImporter: "src/shared/contextHealth.test.ts",
    importPattern: /from\s+["'][^"']*contextHealth(?:\.js)?["']/,
  },
  {
    path: "src/shared/semanticReadiness.ts",
    exportPath: "@agentlink/protocol/semantic-readiness",
    allowedImporter: "src/shared/semanticReadiness.test.ts",
    importPattern: /from\s+["'][^"']*semanticReadiness(?:\.js)?["']/,
  },
  {
    path: "src/shared/mcpConfigValidation.ts",
    exportPath: "@agentlink/protocol/mcp-config-validation",
    allowedImporter: "src/shared/mcpConfigValidation.test.ts",
    importPattern: /from\s+["'][^"']*mcpConfigValidation(?:\.js)?["']/,
  },
  {
    path: "src/shared/mcpConfigImport.ts",
    exportPath: "@agentlink/protocol/mcp-config-import",
    allowedImporter: "src/shared/mcpConfigImport.test.ts",
    importPattern: /from\s+["'][^"']*mcpConfigImport(?:\.js)?["']/,
  },
  {
    path: "src/util/jsonc.ts",
    exportPath: "@agentlink/protocol/jsonc",
    allowedImporter: "src/util/jsonc.test.ts",
    importPattern: /from\s+["'](?:\.\.?\/)+[^"']*jsonc(?:\.js)?["']/,
  },
  {
    path: "src/core/contextLedger.ts",
    exportPath: "@agentlink/protocol/context-ledger",
    allowedImporter: "src/core/contextLedger.test.ts",
    importPattern: /from\s+["'][^"']*contextLedger(?:\.js)?["']/,
  },

  {
    path: "src/core/modelCatalog.ts",
    exportPath: "@agentlink/protocol/model-catalog",
    allowedImporter: "src/core/modelCatalog.test.ts",
    importPattern: /from\s+["'][^"']*modelCatalog(?:\.js)?["']/,
  },
  {
    path: "src/shared/selectionCommands.ts",
    exportPath: "@agentlink/protocol/selection-commands",
    allowedImporter: "src/shared/selectionCommands.test.ts",
    importPattern: /from\s+["'][^"']*selectionCommands(?:\.js)?["']/,
  },
  {
    path: "src/shared/backgroundResultPresentation.ts",
    exportPath: "@agentlink/protocol/background-result",
    allowedImporter: "src/shared/backgroundResultPresentation.test.ts",
    importPattern: /from\s+["'][^"']*backgroundResultPresentation(?:\.js)?["']/,
  },
  {
    path: "src/core/mcpToolNames.ts",
    exportPath: "@agentlink/protocol/mcp-tool-identity",
    allowedImporter: "src/core/mcpToolNames.test.ts",
    importPattern: /from\s+["'](?:\.\.?\/)+core\/mcpToolNames(?:\.js)?["']/,
  },
  {
    path: "src/agent/mcpToolNames.ts",
    exportPath: "@agentlink/protocol/mcp-tool-identity",
    allowedImporter: "src/agent/mcpToolNames.test.ts",
    importPattern: /from\s+["'](?:\.\.?\/)+agent\/mcpToolNames(?:\.js)?["']/,
  },
  {
    path: "src/core/modelAuth.ts",
    exportPath: "@agentlink/protocol/model-auth",
    allowedImporter: "src/core/modelAuth.test.ts",
    importPattern: /from\s+["'][^"']*modelAuth(?:\.js)?["']/,
    additionalExport:
      'export type { CoreModelAuthProvider } from "@agentlink/core/model-auth-provider";',
  },
  {
    path: "src/core/promptProfile.ts",
    exportPath: "@agentlink/protocol/prompt-profile",
    allowedImporter: "src/core/promptProfile.test.ts",
    importPattern: /from\s+["'][^"']*promptProfile(?:\.js)?["']/,
    additionalExport:
      'export { resolvePromptProfile } from "./promptProfilePolicy.js";',
  },
  {
    path: "src/core/terminalProtocol.ts",
    exportPath: "@agentlink/protocol/terminal",
    allowedImporter: "src/core/terminalProtocol.test.ts",
    importPattern: /from\s+["'][^"']*terminalProtocol(?:\.js)?["']/,
  },
  {
    path: "src/shared/questionDetection.ts",
    exportPath: "@agentlink/protocol/question-detection",
    allowedImporter: "src/shared/questionDetection.test.ts",
    importPattern:
      /from\s+["'](?:\.\.?\/)+shared\/questionDetection(?:\.js)?["']/,
  },
  {
    path: "src/shared/builtinCommandForwarding.ts",
    exportPath: "@agentlink/protocol/builtin-command-forwarding",
    allowedImporter: "src/shared/builtinCommandForwarding.test.ts",
    importPattern:
      /from\s+["'](?:\.\.?\/)+shared\/builtinCommandForwarding(?:\.js)?["']/,
  },
];

const MIXED_COMPATIBILITY_EXPORTS = [
  'export type { BgSessionInfo } from "@agentlink/protocol/background-result";',
  'export type { BrowserGatewayThemeSnapshot } from "@agentlink/protocol/browser-gateway-theme";',
  [
    "export type {",
    "  InlineApprovalChoice,",
    "  InlineApprovalDecision,",
    "  InlineApprovalFileWrite,",
    "  InlineApprovalKind,",
    "  InlineApprovalRequest,",
    "  InlineApprovalResult,",
    "  MemoryScope,",
    "  MemoryTier,",
    "  OnApprovalRequest,",
    '} from "@agentlink/protocol/inline-approval";',
  ].join("\n"),
  [
    "export type {",
    "  CondenseForensicMetadata,",
    "  CondenseMetadata,",
    "  ContextBreakdownItem,",
    "  McpServerToolBreakdown,",
    "  PostCondenseProjection,",
    "  RequestContextBreakdown,",
    "  SkillCatalogContextBreakdown,",
    "  ToolContextBreakdown,",
    "  ToolResultContextAttribution,",
    '} from "@agentlink/protocol/context-diagnostics";',
  ].join("\n"),
  [
    "export {",
    "  errorResult,",
    "  handleToolError,",
    "  jsonResult,",
    "  successResult,",
    '} from "@agentlink/protocol/tool-result";',
  ].join("\n"),
  [
    "export type {",
    "  McpApprovalPromotionMeta,",
    "  McpContentAnnotations,",
    "  McpResultContentMeta,",
    "  McpToolResultMeta,",
    "  ToolResult,",
    '} from "@agentlink/protocol/tool-result";',
  ].join("\n"),
  'export type { RevertRecoveryNotice } from "@agentlink/protocol/session-hydration";',
  [
    "export type {",
    "  BackgroundCompletionResult,",
    "  InFlightAssistantBlock,",
    '} from "@agentlink/protocol/session-hydration";',
  ].join("\n"),
] as const;
const MIXED_COMPATIBILITY_TYPE_NAMES = [
  "BackgroundCompletionResult",
  "CondenseForensicMetadata",
  "CondenseMetadata",
  "ContextBreakdownItem",
  "BgSessionInfo",
  "BrowserGatewayThemeSnapshot",
  "InFlightAssistantBlock",
  "InlineApprovalChoice",
  "InlineApprovalDecision",
  "InlineApprovalFileWrite",
  "InlineApprovalKind",
  "InlineApprovalRequest",
  "InlineApprovalResult",
  "MemoryScope",
  "MemoryTier",
  "OnApprovalRequest",
  "McpApprovalPromotionMeta",
  "McpContentAnnotations",
  "McpResultContentMeta",
  "McpServerToolBreakdown",
  "McpToolResultMeta",
  "PostCondenseProjection",
  "RequestContextBreakdown",
  "SkillCatalogContextBreakdown",
  "RevertRecoveryNotice",
  "ToolContextBreakdown",
  "ToolResult",
  "ToolResultContextAttribution",
  "errorResult",
  "handleToolError",
  "jsonResult",
  "successResult",
] as const;

const FORBIDDEN_PROTOCOL_RULES = [
  {
    matches: (source: string) => /from\s+["']vscode["']/.test(source),
    label: "VS Code",
  },
  {
    matches: (source: string) =>
      /from\s+["'](?:node:)?(?:fs|path|os|crypto|child_process|net|http|https|stream|buffer)["']/.test(
        source,
      ),
    label: "Node API",
  },
  { matches: containsNodeGlobalIdentifier, label: "Node global" },
  {
    matches: (source: string) => /["'][^"']*(?:^|\/)src\//.test(source),
    label: "root src",
  },
];

describe("protocol package boundary", () => {
  it("keeps production protocol modules browser-safe and independent from root source", async () => {
    const violations: string[] = [];

    for (const filePath of walkTypeScriptFiles(PROTOCOL_SOURCE)) {
      if (filePath.endsWith(".test.ts")) continue;
      const source = fs.readFileSync(filePath, "utf8");
      for (const rule of FORBIDDEN_PROTOCOL_RULES) {
        if (await rule.matches(source)) {
          violations.push(
            `${path.relative(ROOT, filePath)}: contains ${rule.label}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("detects standalone Node globals without matching string labels", async () => {
    for (const source of [
      "export function read() { return process; }",
      "export function read() { consume(process); }",
      "export const read = () => Buffer;",
      "export const read = () => __dirname;",
      "export const read = () => __filename;",
    ]) {
      await expect(containsNodeGlobalIdentifier(source), source).resolves.toBe(
        true,
      );
    }
    await expect(
      containsNodeGlobalIdentifier(
        'export type DenialReason = "process-control" | "buffer";',
      ),
    ).resolves.toBe(false);
  });

  it("counts type-only star re-exports when enforcing compatibility shims", () => {
    const compatibilityPath = path.join(ROOT, "src/core/webAccess.ts");
    const importerPath = path.join(ROOT, "src/shared/compatibility-fixture.ts");

    expect(
      findCompatibilityImporters({
        compatibilityPath,
        sourceFiles: [
          {
            filePath: importerPath,
            source: 'export type * from "../core/webAccess.js";',
          },
        ],
        extractedNames: ["CoreWebActivity"],
      }),
    ).toEqual(["src/shared/compatibility-fixture.ts"]);
  });

  it("counts escaped namespace imports when enforcing compatibility shims", () => {
    const compatibilityPath = path.join(ROOT, "src/core/webAccess.ts");
    const importerPath = path.join(ROOT, "src/shared/compatibility-fixture.ts");

    expect(
      findCompatibilityImporters({
        compatibilityPath,
        sourceFiles: [
          {
            filePath: importerPath,
            source: [
              'import * as LegacyWeb from "../core/webAccess.js";',
              "export { LegacyWeb };",
            ].join("\n"),
          },
        ],
        extractedNames: ["CoreJsonValue"],
      }),
    ).toEqual(["src/shared/compatibility-fixture.ts"]);
  });

  it("counts dynamic namespace imports when enforcing compatibility shims", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/core/retrieval/contracts.ts",
    );
    const importerPath = path.join(
      ROOT,
      "src/indexer/compatibility-fixture.ts",
    );

    expect(
      findCompatibilityImporters({
        compatibilityPath,
        sourceFiles: [
          {
            filePath: importerPath,
            source: [
              'type Contracts = typeof import("../core/retrieval/contracts.js");',
              'type ActiveSource = Contracts["RetrievalActiveSource"];',
            ].join("\n"),
          },
        ],
        extractedNames: ["RetrievalActiveSource"],
      }),
    ).toEqual(["src/indexer/compatibility-fixture.ts"]);
  });

  it("bundles every public protocol module for a browser without Node fallbacks", async () => {
    const result = await build({
      entryPoints: [
        path.join(PROTOCOL_SOURCE, "agentErrorPresentation.ts"),
        path.join(PROTOCOL_SOURCE, "agentPluginManager.ts"),
        path.join(PROTOCOL_SOURCE, "approvalTransport.ts"),
        path.join(PROTOCOL_SOURCE, "autoContinueProgress.ts"),
        path.join(PROTOCOL_SOURCE, "autonomousMemory.ts"),
        path.join(PROTOCOL_SOURCE, "backgroundResult.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayAskAgentIdentity.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayBackgroundSummary.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayCapabilityStatus.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayChatWorkspaceSummary.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayContextBudget.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayCoreOwnerRegistration.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayDataPlaneIdentity.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayDataPlaneLimits.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayDataPlaneMode.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayDataPlaneTransport.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayDataPlaneVersion.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayDetachedSessionSelection.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayDiffPreview.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayForegroundControlState.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayHelperLifecycle.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayInstanceStatus.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayInteractionState.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayInteractionSummary.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayModelProviderIdentity.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayOperationState.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayOwnerCheckpoint.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayOwnerCommand.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayOwnerCommandAck.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayOwnerCommandBody.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayOwnerCommandMetadata.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayOwnerControl.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayOwnerControlMetadata.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayOwnerEvent.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayOwnerEventMetadata.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayOwnerInteractionPayload.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayOwnerPublicationBatch.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayProtocolError.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayQueueItem.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayRepositoryState.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewaySessionCatalog.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayTheme.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayTodoItem.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayTranscriptBlock.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayTranscriptMessage.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayTranscriptText.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayTranscriptWindow.ts"),
        path.join(PROTOCOL_SOURCE, "builtinCommandForwarding.ts"),
        path.join(PROTOCOL_SOURCE, "chatCatalog.ts"),
        path.join(PROTOCOL_SOURCE, "chatPaneTransport.ts"),
        path.join(PROTOCOL_SOURCE, "chatSessionHistory.ts"),
        path.join(PROTOCOL_SOURCE, "chatState.ts"),
        path.join(PROTOCOL_SOURCE, "chatTranscript.ts"),
        path.join(PROTOCOL_SOURCE, "chatWorkspace.ts"),
        path.join(PROTOCOL_SOURCE, "commandApprovalPolicy.ts"),
        path.join(PROTOCOL_SOURCE, "compose.ts"),
        path.join(PROTOCOL_SOURCE, "contextDiagnostics.ts"),
        path.join(PROTOCOL_SOURCE, "contextHealth.ts"),
        path.join(PROTOCOL_SOURCE, "contextLedger.ts"),
        path.join(PROTOCOL_SOURCE, "diffSnapshot.ts"),
        path.join(PROTOCOL_SOURCE, "finalStatus.ts"),
        path.join(PROTOCOL_SOURCE, "findReplacePreview.ts"),
        path.join(PROTOCOL_SOURCE, "fleetResult.ts"),
        path.join(PROTOCOL_SOURCE, "inlineApproval.ts"),
        path.join(PROTOCOL_SOURCE, "jsonc.ts"),
        path.join(PROTOCOL_SOURCE, "mcpConfigImport.ts"),
        path.join(PROTOCOL_SOURCE, "mcpConfigValidation.ts"),
        path.join(PROTOCOL_SOURCE, "mcpElicitation.ts"),
        path.join(PROTOCOL_SOURCE, "mcpManager.ts"),
        path.join(PROTOCOL_SOURCE, "mcpToolIdentity.ts"),
        path.join(PROTOCOL_SOURCE, "mcpUrlElicitation.ts"),
        path.join(PROTOCOL_SOURCE, "modelAuth.ts"),
        path.join(PROTOCOL_SOURCE, "modelCatalog.ts"),
        path.join(PROTOCOL_SOURCE, "modelSetup.ts"),
        path.join(PROTOCOL_SOURCE, "promptProfile.ts"),
        path.join(PROTOCOL_SOURCE, "providerReplay.ts"),
        path.join(PROTOCOL_SOURCE, "questionConfirmation.ts"),
        path.join(PROTOCOL_SOURCE, "questionDetection.ts"),
        path.join(PROTOCOL_SOURCE, "retrievalDeletion.ts"),
        path.join(PROTOCOL_SOURCE, "retrievalFingerprint.ts"),
        path.join(PROTOCOL_SOURCE, "retrievalMaintenance.ts"),
        path.join(PROTOCOL_SOURCE, "retrievalStructuralSnapshot.ts"),
        path.join(PROTOCOL_SOURCE, "retrievalHealth.ts"),
        path.join(PROTOCOL_SOURCE, "retrievalPublication.ts"),
        path.join(PROTOCOL_SOURCE, "retrievalQuery.ts"),
        path.join(PROTOCOL_SOURCE, "retrievalRecords.ts"),
        path.join(PROTOCOL_SOURCE, "selectionCommands.ts"),
        path.join(PROTOCOL_SOURCE, "semanticReadiness.ts"),
        path.join(PROTOCOL_SOURCE, "session.ts"),
        path.join(PROTOCOL_SOURCE, "sessionHandoffDraft.ts"),
        path.join(PROTOCOL_SOURCE, "structuredQuestion.ts"),
        path.join(PROTOCOL_SOURCE, "surfaceModelMessage.ts"),
        path.join(PROTOCOL_SOURCE, "sessionHydration.ts"),
        path.join(PROTOCOL_SOURCE, "sidebarTransport.ts"),
        path.join(PROTOCOL_SOURCE, "terminal.ts"),
        path.join(PROTOCOL_SOURCE, "terminalSecurity.ts"),
        path.join(PROTOCOL_SOURCE, "terminalSurface.ts"),
        path.join(PROTOCOL_SOURCE, "todoContinuation.ts"),
        path.join(PROTOCOL_SOURCE, "toolResult.ts"),
        path.join(PROTOCOL_SOURCE, "webAccessPolicy.ts"),
        path.join(PROTOCOL_SOURCE, "webActivity.ts"),
        path.join(PROTOCOL_SOURCE, "workspaceProject.ts"),
      ],
      bundle: true,
      platform: "browser",
      format: "esm",
      outdir: "out",
      write: false,
      logLevel: "silent",
      metafile: true,
    });

    expect(result.errors).toEqual([]);
    expect(
      Object.keys(result.metafile?.inputs ?? {}).some((input) =>
        input.includes("node_modules"),
      ),
    ).toBe(false);
  });

  it("wires the final Phase A2 browser-gateway DTO batch through every public package surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    const modules = [
      {
        exportPath: "browser-gateway-data-plane-transport",
        fileName: "browserGatewayDataPlaneTransport",
        declarationDependencies: [
          "browserGatewayCapabilityStatus",
          "browserGatewayDataPlaneIdentity",
          "browserGatewayOwnerControlMetadata",
          "browserGatewayDataPlaneVersion",
        ],
      },
      {
        exportPath: "browser-gateway-owner-interaction-payload",
        fileName: "browserGatewayOwnerInteractionPayload",
        declarationDependencies: [
          "approvalTransport",
          "mcpElicitation",
          "mcpUrlElicitation",
          "structuredQuestion",
        ],
      },
    ] as const;
    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    const buildScripts = ["build-cjs.mjs", "watch.mjs"].map((fileName) => ({
      fileName,
      source: fs.readFileSync(
        path.join(ROOT, "packages", "protocol", fileName),
        "utf8",
      ),
    }));
    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");

    for (const module of modules) {
      expect(packageManifest.exports?.[`./${module.exportPath}`]).toEqual({
        browser: {
          types: `./dist/${module.fileName}.d.ts`,
          default: `./dist/${module.fileName}.js`,
        },
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
        expect(buildScript.source, buildScript.fileName).toContain(
          `"src/${module.fileName}.ts"`,
        );
        expect(buildScript.source, buildScript.fileName).toContain(
          `"dist/cjs/${module.fileName}.d.cts"`,
        );
        expect(buildScript.source, buildScript.fileName).toContain(
          `export * from "./${module.fileName}.cjs";\\n`,
        );
        for (const dependency of module.declarationDependencies) {
          expect(
            buildScript.source,
            `${buildScript.fileName}:${dependency}`,
          ).toContain(`'"./${dependency}.cjs"'`);
        }
      }

      const declaration = fs.readFileSync(
        path.join(cjsDirectory, `${module.fileName}.d.cts`),
        "utf8",
      );
      for (const dependency of module.declarationDependencies) {
        expect(declaration).toContain(`from "./${dependency}.cjs"`);
      }
      expect(
        fs.existsSync(path.join(cjsDirectory, `${module.fileName}.cjs`)),
      ).toBe(true);
      expect(() =>
        requireFromBoundaryTest(`@agentlink/protocol/${module.exportPath}`),
      ).not.toThrow();
    }
  });

  it("wires approval-transport through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./approval-transport"]).toEqual({
      browser: {
        types: "./dist/approvalTransport.d.ts",
        default: "./dist/approvalTransport.js",
      },
      import: {
        types: "./dist/approvalTransport.d.ts",
        default: "./dist/approvalTransport.js",
      },
      require: {
        types: "./dist/cjs/approvalTransport.d.cts",
        default: "./dist/cjs/approvalTransport.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain("`approvalTransport` is subpath-only");
    expect(indexSource).not.toContain(
      'export * from "./approvalTransport.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/approvalTransport.ts"');
      expect(source, buildScript).toContain(
        '"dist/cjs/approvalTransport.d.cts"',
      );
      expect(source, buildScript).not.toContain(
        'export * from "./approvalTransport.cjs";',
      );
    }
  });

  it("wires web-access-policy through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./web-access-policy"]).toEqual({
      browser: {
        types: "./dist/webAccessPolicy.d.ts",
        default: "./dist/webAccessPolicy.js",
      },
      import: {
        types: "./dist/webAccessPolicy.d.ts",
        default: "./dist/webAccessPolicy.js",
      },
      require: {
        types: "./dist/cjs/webAccessPolicy.d.cts",
        default: "./dist/cjs/webAccessPolicy.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./webAccessPolicy.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/webAccessPolicy.ts"');
      expect(source, buildScript).toContain(
        'readFile("dist/webAccessPolicy.d.ts", "utf8")',
      );
      expect(source, buildScript).toContain('"dist/cjs/webAccessPolicy.d.cts"');
      expect(source, buildScript).toContain(
        'export * from "./webAccessPolicy.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /readFile\("dist\/webAccessPolicy\.d\.ts", "utf8"\)\.then\(\(content\) => writeFile\( "dist\/cjs\/webAccessPolicy\.d\.cts", content\.replaceAll\(\s*'"\.\/webActivity\.js"'\s*,\s*'"\.\/webActivity\.cjs"'\s*,?\s*\), \), \)/,
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./webAccessPolicy.cjs";');
    expect(
      fs.readFileSync(path.join(cjsDirectory, "webAccessPolicy.d.cts"), "utf8"),
    ).toContain('from "./webActivity.cjs";');
    expect(fs.existsSync(path.join(cjsDirectory, "webAccessPolicy.cjs"))).toBe(
      true,
    );
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest("@agentlink/protocol/web-access-policy"),
    ).not.toThrow();
  });

  it("wires web-activity through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./web-activity"]).toEqual({
      browser: {
        types: "./dist/webActivity.d.ts",
        default: "./dist/webActivity.js",
      },
      import: {
        types: "./dist/webActivity.d.ts",
        default: "./dist/webActivity.js",
      },
      require: {
        types: "./dist/cjs/webActivity.d.cts",
        default: "./dist/cjs/webActivity.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./webActivity.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/webActivity.ts"');
      expect(source, buildScript).toContain('"dist/cjs/webActivity.d.cts"');
      expect(source, buildScript).toContain(
        'export * from "./webActivity.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./webActivity.cjs";');
    expect(
      fs.readFileSync(path.join(cjsDirectory, "webActivity.d.cts"), "utf8"),
    ).toContain("export interface CoreWebActivity");
    expect(fs.existsSync(path.join(cjsDirectory, "webActivity.cjs"))).toBe(
      true,
    );
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest("@agentlink/protocol/web-activity"),
    ).not.toThrow();
  });

  it("wires provider-replay through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./provider-replay"]).toEqual({
      browser: {
        types: "./dist/providerReplay.d.ts",
        default: "./dist/providerReplay.js",
      },
      import: {
        types: "./dist/providerReplay.d.ts",
        default: "./dist/providerReplay.js",
      },
      require: {
        types: "./dist/cjs/providerReplay.d.cts",
        default: "./dist/cjs/providerReplay.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./providerReplay.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/providerReplay.ts"');
      expect(source, buildScript).toContain('"dist/cjs/providerReplay.d.cts"');
      expect(source, buildScript).toContain(
        'export * from "./providerReplay.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./providerReplay.cjs";');
    expect(
      fs.readFileSync(path.join(cjsDirectory, "providerReplay.d.cts"), "utf8"),
    ).toContain("export interface CoreProviderReplayEnvelope");
    expect(fs.existsSync(path.join(cjsDirectory, "providerReplay.cjs"))).toBe(
      true,
    );
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest("@agentlink/protocol/provider-replay"),
    ).not.toThrow();
  });

  it("wires retrieval-deletion through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./retrieval-deletion"]).toEqual({
      browser: {
        types: "./dist/retrievalDeletion.d.ts",
        default: "./dist/retrievalDeletion.js",
      },
      import: {
        types: "./dist/retrievalDeletion.d.ts",
        default: "./dist/retrievalDeletion.js",
      },
      require: {
        types: "./dist/cjs/retrievalDeletion.d.cts",
        default: "./dist/cjs/retrievalDeletion.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./retrievalDeletion.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/retrievalDeletion.ts"');
      expect(source, buildScript).toContain(
        'readFile("dist/retrievalDeletion.d.ts", "utf8")',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/retrievalDeletion.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./retrievalDeletion.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /readFile\("dist\/retrievalDeletion\.d\.ts", "utf8"\)\.then\(\(content\) => writeFile\( "dist\/cjs\/retrievalDeletion\.d\.cts", content\.replaceAll\(\s*'"\.\/retrievalRecords\.js"'\s*,\s*'"\.\/retrievalRecords\.cjs"'\s*,?\s*\), \), \)/,
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    const cjsRootDeclaration = fs.readFileSync(
      path.join(cjsDirectory, "index.d.cts"),
      "utf8",
    );
    expect(cjsRootDeclaration).toContain(
      'export * from "./retrievalDeletion.cjs";',
    );
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "retrievalDeletion.d.cts"),
        "utf8",
      ),
    ).toContain('from "./retrievalRecords.cjs";');
    expect(
      fs.existsSync(path.join(cjsDirectory, "retrievalDeletion.cjs")),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest("@agentlink/protocol/retrieval-deletion"),
    ).not.toThrow();
  });

  it("wires retrieval-fingerprint through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./retrieval-fingerprint"]).toEqual({
      browser: {
        types: "./dist/retrievalFingerprint.d.ts",
        default: "./dist/retrievalFingerprint.js",
      },
      import: {
        types: "./dist/retrievalFingerprint.d.ts",
        default: "./dist/retrievalFingerprint.js",
      },
      require: {
        types: "./dist/cjs/retrievalFingerprint.d.cts",
        default: "./dist/cjs/retrievalFingerprint.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./retrievalFingerprint.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/retrievalFingerprint.ts"');
      expect(source, buildScript).toContain(
        '"dist/cjs/retrievalFingerprint.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./retrievalFingerprint.cjs";\\n',
      );
    }
  });

  it("wires retrieval-maintenance through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./retrieval-maintenance"]).toEqual({
      browser: {
        types: "./dist/retrievalMaintenance.d.ts",
        default: "./dist/retrievalMaintenance.js",
      },
      import: {
        types: "./dist/retrievalMaintenance.d.ts",
        default: "./dist/retrievalMaintenance.js",
      },
      require: {
        types: "./dist/cjs/retrievalMaintenance.d.cts",
        default: "./dist/cjs/retrievalMaintenance.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./retrievalMaintenance.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/retrievalMaintenance.ts"');
      expect(source, buildScript).toContain(
        '"dist/cjs/retrievalMaintenance.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./retrievalMaintenance.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    const cjsRootDeclaration = fs.readFileSync(
      path.join(cjsDirectory, "index.d.cts"),
      "utf8",
    );
    expect(cjsRootDeclaration).toContain(
      'export * from "./retrievalMaintenance.cjs";',
    );
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "retrievalMaintenance.d.cts"),
        "utf8",
      ),
    ).toContain("export interface RetrievalAggregateMetrics");
    expect(fs.existsSync(path.join(cjsDirectory, "index.cjs"))).toBe(true);
    expect(
      fs.existsSync(path.join(cjsDirectory, "retrievalMaintenance.cjs")),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest("@agentlink/protocol/retrieval-maintenance"),
    ).not.toThrow();
  });

  it("wires retrieval-structural-snapshot through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./retrieval-structural-snapshot"],
    ).toEqual({
      browser: {
        types: "./dist/retrievalStructuralSnapshot.d.ts",
        default: "./dist/retrievalStructuralSnapshot.js",
      },
      import: {
        types: "./dist/retrievalStructuralSnapshot.d.ts",
        default: "./dist/retrievalStructuralSnapshot.js",
      },
      require: {
        types: "./dist/cjs/retrievalStructuralSnapshot.d.cts",
        default: "./dist/cjs/retrievalStructuralSnapshot.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./retrievalStructuralSnapshot.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/retrievalStructuralSnapshot.ts"',
      );
      expect(source, buildScript).toContain(
        'readFile("dist/retrievalStructuralSnapshot.d.ts", "utf8")',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/retrievalStructuralSnapshot.d.cts"',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /content \.replaceAll\(\s*'"\.\/retrievalFingerprint\.js"'\s*,\s*'"\.\/retrievalFingerprint\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/retrievalQuery\.js"'\s*,\s*'"\.\/retrievalQuery\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/retrievalRecords\.js"'\s*,\s*'"\.\/retrievalRecords\.cjs"'\s*,?\s*\)/,
      );
      expect(source, buildScript).toContain(
        'export * from "./retrievalStructuralSnapshot.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    const cjsRootDeclaration = fs.readFileSync(
      path.join(cjsDirectory, "index.d.cts"),
      "utf8",
    );
    expect(cjsRootDeclaration).toContain(
      'export * from "./retrievalStructuralSnapshot.cjs";',
    );
    const cjsDeclaration = fs.readFileSync(
      path.join(cjsDirectory, "retrievalStructuralSnapshot.d.cts"),
      "utf8",
    );
    expect(cjsDeclaration).toContain('from "./retrievalFingerprint.cjs";');
    expect(cjsDeclaration).toContain('from "./retrievalQuery.cjs";');
    expect(cjsDeclaration).toContain('from "./retrievalRecords.cjs";');
    expect(
      fs.existsSync(path.join(cjsDirectory, "retrievalStructuralSnapshot.cjs")),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/retrieval-structural-snapshot",
      ),
    ).not.toThrow();
  });

  it("wires retrieval-health through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./retrieval-health"]).toEqual({
      browser: {
        types: "./dist/retrievalHealth.d.ts",
        default: "./dist/retrievalHealth.js",
      },
      import: {
        types: "./dist/retrievalHealth.d.ts",
        default: "./dist/retrievalHealth.js",
      },
      require: {
        types: "./dist/cjs/retrievalHealth.d.cts",
        default: "./dist/cjs/retrievalHealth.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./retrievalHealth.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/retrievalHealth.ts"');
      expect(source, buildScript).toContain(
        'readFile("dist/retrievalHealth.d.ts", "utf8")',
      );
      expect(source, buildScript).toContain('"dist/cjs/retrievalHealth.d.cts"');
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /content\.replaceAll\(\s*'"\.\/retrievalFingerprint\.js"'\s*,\s*'"\.\/retrievalFingerprint\.cjs"'\s*,?\s*\)/,
      );
      expect(normalizedSource, buildScript).toMatch(
        /content\.replaceAll\(\s*'"\.\/retrievalHealth\.js"'\s*,\s*'"\.\/retrievalHealth\.cjs"'\s*,?\s*\)/,
      );
      expect(source, buildScript).toContain(
        'export * from "./retrievalHealth.cjs";\\n',
      );
    }
  });

  it("wires retrieval-publication through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./retrieval-publication"]).toEqual({
      browser: {
        types: "./dist/retrievalPublication.d.ts",
        default: "./dist/retrievalPublication.js",
      },
      import: {
        types: "./dist/retrievalPublication.d.ts",
        default: "./dist/retrievalPublication.js",
      },
      require: {
        types: "./dist/cjs/retrievalPublication.d.cts",
        default: "./dist/cjs/retrievalPublication.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./retrievalPublication.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/retrievalPublication.ts"');
      expect(source, buildScript).toContain(
        'readFile("dist/retrievalPublication.d.ts", "utf8")',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/retrievalPublication.d.cts"',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /readFile\("dist\/retrievalPublication\.d\.ts", "utf8"\)\.then\(\(content\) => writeFile\( "dist\/cjs\/retrievalPublication\.d\.cts", content\.replaceAll\(\s*'"\.\/retrievalRecords\.js"'\s*,\s*'"\.\/retrievalRecords\.cjs"'\s*,?\s*\), \), \)/,
      );
      expect(source, buildScript).toContain(
        'export * from "./retrievalPublication.cjs";\\n',
      );
    }
  });

  it("wires retrieval-query through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./retrieval-query"]).toEqual({
      browser: {
        types: "./dist/retrievalQuery.d.ts",
        default: "./dist/retrievalQuery.js",
      },
      import: {
        types: "./dist/retrievalQuery.d.ts",
        default: "./dist/retrievalQuery.js",
      },
      require: {
        types: "./dist/cjs/retrievalQuery.d.cts",
        default: "./dist/cjs/retrievalQuery.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./retrievalQuery.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/retrievalQuery.ts"');
      expect(source, buildScript).toContain(
        'readFile("dist/retrievalQuery.d.ts", "utf8")',
      );
      expect(source, buildScript).toContain('"dist/cjs/retrievalQuery.d.cts"');
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /readFile\("dist\/retrievalQuery\.d\.ts", "utf8"\)\.then\(\(content\) => writeFile\( "dist\/cjs\/retrievalQuery\.d\.cts", content \.replaceAll\(\s*'"\.\/retrievalHealth\.js"'\s*,\s*'"\.\/retrievalHealth\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/retrievalRecords\.js"'\s*,\s*'"\.\/retrievalRecords\.cjs"'\s*,?\s*\), \), \)/,
      );
      expect(source, buildScript).toContain(
        'export * from "./retrievalQuery.cjs";\\n',
      );
    }
  });

  it("wires retrieval-records through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./retrieval-records"]).toEqual({
      browser: {
        types: "./dist/retrievalRecords.d.ts",
        default: "./dist/retrievalRecords.js",
      },
      import: {
        types: "./dist/retrievalRecords.d.ts",
        default: "./dist/retrievalRecords.js",
      },
      require: {
        types: "./dist/cjs/retrievalRecords.d.cts",
        default: "./dist/cjs/retrievalRecords.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./retrievalRecords.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/retrievalRecords.ts"');
      expect(source, buildScript).toContain(
        '"dist/cjs/retrievalRecords.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./retrievalRecords.cjs";\\n',
      );
    }
  });

  it("wires session-handoff-draft through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./session-handoff-draft"]).toEqual({
      browser: {
        types: "./dist/sessionHandoffDraft.d.ts",
        default: "./dist/sessionHandoffDraft.js",
      },
      import: {
        types: "./dist/sessionHandoffDraft.d.ts",
        default: "./dist/sessionHandoffDraft.js",
      },
      require: {
        types: "./dist/cjs/sessionHandoffDraft.d.cts",
        default: "./dist/cjs/sessionHandoffDraft.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./sessionHandoffDraft.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/sessionHandoffDraft.ts"');
      expect(source, buildScript).toContain(
        '"dist/cjs/sessionHandoffDraft.d.cts"',
      );
      expect(source, buildScript).toContain('"./sessionHandoffDraft.cjs"');
    }
  });

  it("wires sidebar-transport through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./sidebar-transport"]).toEqual({
      browser: {
        types: "./dist/sidebarTransport.d.ts",
        default: "./dist/sidebarTransport.js",
      },
      import: {
        types: "./dist/sidebarTransport.d.ts",
        default: "./dist/sidebarTransport.js",
      },
      require: {
        types: "./dist/cjs/sidebarTransport.d.cts",
        default: "./dist/cjs/sidebarTransport.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain("`sidebarTransport` is subpath-only");
    expect(indexSource).not.toContain('export * from "./sidebarTransport.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/sidebarTransport.ts"');
      expect(source, buildScript).toContain(
        '"dist/cjs/sidebarTransport.d.cts"',
      );
      expect(source, buildScript).not.toContain('"./sidebarTransport.cjs"');
    }
  });

  it("wires browser-gateway-ask-agent-identity through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-ask-agent-identity"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayAskAgentIdentity.d.ts",
        default: "./dist/browserGatewayAskAgentIdentity.js",
      },
      import: {
        types: "./dist/browserGatewayAskAgentIdentity.d.ts",
        default: "./dist/browserGatewayAskAgentIdentity.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayAskAgentIdentity.d.cts",
        default: "./dist/cjs/browserGatewayAskAgentIdentity.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayAskAgentIdentity.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayAskAgentIdentity.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayAskAgentIdentity.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayAskAgentIdentity.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayAskAgentIdentity.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayAskAgentIdentity.d.cts"),
        "utf8",
      ),
    ).toContain("export declare function isBrowserGatewayAskAgentSessionId");
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayAskAgentIdentity.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-ask-agent-identity",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-core-owner-registration through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-core-owner-registration"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayCoreOwnerRegistration.d.ts",
        default: "./dist/browserGatewayCoreOwnerRegistration.js",
      },
      import: {
        types: "./dist/browserGatewayCoreOwnerRegistration.d.ts",
        default: "./dist/browserGatewayCoreOwnerRegistration.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayCoreOwnerRegistration.d.cts",
        default: "./dist/cjs/browserGatewayCoreOwnerRegistration.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayCoreOwnerRegistration.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayCoreOwnerRegistration.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayCoreOwnerRegistration.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayCoreOwnerRegistration.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /\.replaceAll\('"\.\/session\.js"', '"\.\/session\.cjs"'\)/,
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayCoreOwnerRegistration.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayCoreOwnerRegistration.d.cts"),
        "utf8",
      ),
    ).toContain('from "./session.cjs";');
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayCoreOwnerRegistration.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-core-owner-registration",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-helper-lifecycle through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-helper-lifecycle"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayHelperLifecycle.d.ts",
        default: "./dist/browserGatewayHelperLifecycle.js",
      },
      import: {
        types: "./dist/browserGatewayHelperLifecycle.d.ts",
        default: "./dist/browserGatewayHelperLifecycle.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayHelperLifecycle.d.cts",
        default: "./dist/cjs/browserGatewayHelperLifecycle.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayHelperLifecycle.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayHelperLifecycle.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayHelperLifecycle.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayHelperLifecycle.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /\.replaceAll\( '"\.\/browserGatewayDataPlaneMode\.js"', '"\.\/browserGatewayDataPlaneMode\.cjs"', \)/,
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayHelperLifecycle.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayHelperLifecycle.d.cts"),
        "utf8",
      ),
    ).toContain('from "./browserGatewayDataPlaneMode.cjs";');
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayHelperLifecycle.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-helper-lifecycle",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway relay theme state through the existing public package surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./browser-gateway-theme"]).toEqual({
      browser: {
        types: "./dist/browserGatewayTheme.d.ts",
        default: "./dist/browserGatewayTheme.js",
      },
      import: {
        types: "./dist/browserGatewayTheme.d.ts",
        default: "./dist/browserGatewayTheme.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayTheme.d.cts",
        default: "./dist/cjs/browserGatewayTheme.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./browserGatewayTheme.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/browserGatewayTheme.ts"');
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayTheme.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayTheme.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayTheme.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayTheme.d.cts"),
        "utf8",
      ),
    ).toContain("export interface BrowserGatewayThemeState");
    const themeModule = requireFromBoundaryTest(
      "@agentlink/protocol/browser-gateway-theme",
    ) as { BROWSER_GATEWAY_COLOR_SCHEMES?: readonly string[] };
    expect(themeModule.BROWSER_GATEWAY_COLOR_SCHEMES).toEqual([
      "light",
      "dark",
      "hc",
      "hc-light",
    ]);
    expect(Object.isFrozen(themeModule.BROWSER_GATEWAY_COLOR_SCHEMES)).toBe(
      true,
    );
    expect(() =>
      (themeModule.BROWSER_GATEWAY_COLOR_SCHEMES as unknown as string[]).push(
        "other",
      ),
    ).toThrow(TypeError);
  });

  it("wires browser-gateway-background-summary through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-background-summary"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayBackgroundSummary.d.ts",
        default: "./dist/browserGatewayBackgroundSummary.js",
      },
      import: {
        types: "./dist/browserGatewayBackgroundSummary.d.ts",
        default: "./dist/browserGatewayBackgroundSummary.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayBackgroundSummary.d.cts",
        default: "./dist/cjs/browserGatewayBackgroundSummary.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayBackgroundSummary.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayBackgroundSummary.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayBackgroundSummary.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayBackgroundSummary.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayBackgroundSummary.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayBackgroundSummary.d.cts"),
        "utf8",
      ),
    ).toContain("export interface BrowserGatewayBackgroundSummary");
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayBackgroundSummary.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-background-summary",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-transcript-window through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-transcript-window"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayTranscriptWindow.d.ts",
        default: "./dist/browserGatewayTranscriptWindow.js",
      },
      import: {
        types: "./dist/browserGatewayTranscriptWindow.d.ts",
        default: "./dist/browserGatewayTranscriptWindow.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayTranscriptWindow.d.cts",
        default: "./dist/cjs/browserGatewayTranscriptWindow.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayTranscriptWindow.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayTranscriptWindow.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayTranscriptWindow.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayTranscriptWindow.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /readFile\("dist\/browserGatewayTranscriptWindow\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayTranscriptWindow\.d\.cts", content\.replaceAll\(\s*'"\.\/browserGatewayTranscriptMessage\.js"'\s*,\s*'"\.\/browserGatewayTranscriptMessage\.cjs"'\s*,?\s*\), \), \)/,
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayTranscriptWindow.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayTranscriptWindow.d.cts"),
        "utf8",
      ),
    ).toContain(
      'import type { BrowserGatewayTranscriptMessage } from "./browserGatewayTranscriptMessage.cjs";',
    );
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayTranscriptWindow.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-transcript-window",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-transcript-message through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-transcript-message"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayTranscriptMessage.d.ts",
        default: "./dist/browserGatewayTranscriptMessage.js",
      },
      import: {
        types: "./dist/browserGatewayTranscriptMessage.d.ts",
        default: "./dist/browserGatewayTranscriptMessage.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayTranscriptMessage.d.cts",
        default: "./dist/cjs/browserGatewayTranscriptMessage.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayTranscriptMessage.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayTranscriptMessage.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayTranscriptMessage.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayTranscriptMessage.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /readFile\("dist\/browserGatewayTranscriptMessage\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayTranscriptMessage\.d\.cts", content \.replaceAll\(\s*'"\.\/browserGatewayTranscriptBlock\.js"'\s*,\s*'"\.\/browserGatewayTranscriptBlock\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/browserGatewayTranscriptText\.js"'\s*,\s*'"\.\/browserGatewayTranscriptText\.cjs"'\s*,?\s*\), \), \)/,
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayTranscriptMessage.cjs";');
    const declaration = fs.readFileSync(
      path.join(cjsDirectory, "browserGatewayTranscriptMessage.d.cts"),
      "utf8",
    );
    for (const dependency of [
      "browserGatewayTranscriptBlock",
      "browserGatewayTranscriptText",
    ]) {
      expect(declaration).toContain(`from "./${dependency}.cjs";`);
    }
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayTranscriptMessage.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-transcript-message",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-transcript-block through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-transcript-block"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayTranscriptBlock.d.ts",
        default: "./dist/browserGatewayTranscriptBlock.js",
      },
      import: {
        types: "./dist/browserGatewayTranscriptBlock.d.ts",
        default: "./dist/browserGatewayTranscriptBlock.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayTranscriptBlock.d.cts",
        default: "./dist/cjs/browserGatewayTranscriptBlock.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayTranscriptBlock.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayTranscriptBlock.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayTranscriptBlock.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayTranscriptBlock.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /readFile\("dist\/browserGatewayTranscriptBlock\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayTranscriptBlock\.d\.cts", content \.replaceAll\(\s*'"\.\/backgroundResult\.js"'\s*,\s*'"\.\/backgroundResult\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/browserGatewayTranscriptText\.js"'\s*,\s*'"\.\/browserGatewayTranscriptText\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/modelCatalog\.js"'\s*,\s*'"\.\/modelCatalog\.cjs"'\s*,?\s*\), \), \)/,
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayTranscriptBlock.cjs";');
    const declaration = fs.readFileSync(
      path.join(cjsDirectory, "browserGatewayTranscriptBlock.d.cts"),
      "utf8",
    );
    for (const dependency of [
      "backgroundResult",
      "browserGatewayTranscriptText",
      "modelCatalog",
    ]) {
      expect(declaration).toContain(`from "./${dependency}.cjs";`);
    }
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayTranscriptBlock.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-transcript-block",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-transcript-text through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-transcript-text"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayTranscriptText.d.ts",
        default: "./dist/browserGatewayTranscriptText.js",
      },
      import: {
        types: "./dist/browserGatewayTranscriptText.d.ts",
        default: "./dist/browserGatewayTranscriptText.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayTranscriptText.d.cts",
        default: "./dist/cjs/browserGatewayTranscriptText.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayTranscriptText.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayTranscriptText.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayTranscriptText.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayTranscriptText.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /readFile\("dist\/browserGatewayTranscriptText\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayTranscriptText\.d\.cts", content\.replaceAll\(\s*'"\.\/browserGatewayDataPlaneIdentity\.js"'\s*,\s*'"\.\/browserGatewayDataPlaneIdentity\.cjs"'\s*,?\s*\), \), \)/,
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayTranscriptText.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayTranscriptText.d.cts"),
        "utf8",
      ),
    ).toContain(
      'import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.cjs";',
    );
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayTranscriptText.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-transcript-text",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-detached-session-selection through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-detached-session-selection"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayDetachedSessionSelection.d.ts",
        default: "./dist/browserGatewayDetachedSessionSelection.js",
      },
      import: {
        types: "./dist/browserGatewayDetachedSessionSelection.d.ts",
        default: "./dist/browserGatewayDetachedSessionSelection.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayDetachedSessionSelection.d.cts",
        default: "./dist/cjs/browserGatewayDetachedSessionSelection.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayDetachedSessionSelection.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayDetachedSessionSelection.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayDetachedSessionSelection.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayDetachedSessionSelection.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain(
      'export * from "./browserGatewayDetachedSessionSelection.cjs";',
    );
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayDetachedSessionSelection.d.cts"),
        "utf8",
      ),
    ).toContain("export interface BrowserGatewayDetachedSessionSelection");
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-detached-session-selection",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-diff-preview through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./browser-gateway-diff-preview"]).toEqual(
      {
        browser: {
          types: "./dist/browserGatewayDiffPreview.d.ts",
          default: "./dist/browserGatewayDiffPreview.js",
        },
        import: {
          types: "./dist/browserGatewayDiffPreview.d.ts",
          default: "./dist/browserGatewayDiffPreview.js",
        },
        require: {
          types: "./dist/cjs/browserGatewayDiffPreview.d.cts",
          default: "./dist/cjs/browserGatewayDiffPreview.cjs",
        },
      },
    );

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayDiffPreview.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayDiffPreview.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayDiffPreview.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayDiffPreview.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /readFile\("dist\/browserGatewayDiffPreview\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayDiffPreview\.d\.cts", content\.replaceAll\(\s*'"\.\/browserGatewayDataPlaneIdentity\.js"'\s*,\s*'"\.\/browserGatewayDataPlaneIdentity\.cjs"'\s*,?\s*\), \), \)/,
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayDiffPreview.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayDiffPreview.d.cts"),
        "utf8",
      ),
    ).toContain(
      'import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.cjs";',
    );
    expect(
      fs.existsSync(path.join(cjsDirectory, "browserGatewayDiffPreview.cjs")),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-diff-preview",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-interaction-state through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-interaction-state"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayInteractionState.d.ts",
        default: "./dist/browserGatewayInteractionState.js",
      },
      import: {
        types: "./dist/browserGatewayInteractionState.d.ts",
        default: "./dist/browserGatewayInteractionState.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayInteractionState.d.cts",
        default: "./dist/cjs/browserGatewayInteractionState.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayInteractionState.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayInteractionState.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayInteractionState.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayInteractionState.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /readFile\("dist\/browserGatewayInteractionState\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayInteractionState\.d\.cts", content \.replaceAll\(\s*'"\.\/browserGatewayInteractionSummary\.js"'\s*,\s*'"\.\/browserGatewayInteractionSummary\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/browserGatewayOperationState\.js"'\s*,\s*'"\.\/browserGatewayOperationState\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/browserGatewayQueueItem\.js"'\s*,\s*'"\.\/browserGatewayQueueItem\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/browserGatewayTodoItem\.js"'\s*,\s*'"\.\/browserGatewayTodoItem\.cjs"'\s*,?\s*\), \), \)/,
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayInteractionState.cjs";');
    const declaration = fs.readFileSync(
      path.join(cjsDirectory, "browserGatewayInteractionState.d.cts"),
      "utf8",
    );
    for (const dependency of [
      "browserGatewayInteractionSummary",
      "browserGatewayOperationState",
      "browserGatewayQueueItem",
      "browserGatewayTodoItem",
    ]) {
      expect(declaration).toContain(`from "./${dependency}.cjs";`);
    }
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayInteractionState.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-interaction-state",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-interaction-summary through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-interaction-summary"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayInteractionSummary.d.ts",
        default: "./dist/browserGatewayInteractionSummary.js",
      },
      import: {
        types: "./dist/browserGatewayInteractionSummary.d.ts",
        default: "./dist/browserGatewayInteractionSummary.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayInteractionSummary.d.cts",
        default: "./dist/cjs/browserGatewayInteractionSummary.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayInteractionSummary.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayInteractionSummary.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayInteractionSummary.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayInteractionSummary.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /readFile\("dist\/browserGatewayInteractionSummary\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayInteractionSummary\.d\.cts", content\.replaceAll\(\s*'"\.\/browserGatewayDataPlaneIdentity\.js"'\s*,\s*'"\.\/browserGatewayDataPlaneIdentity\.cjs"'\s*,?\s*\), \), \)/,
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayInteractionSummary.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayInteractionSummary.d.cts"),
        "utf8",
      ),
    ).toContain(
      'import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.cjs";',
    );
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayInteractionSummary.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-interaction-summary",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway owner-control metadata through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-owner-control-metadata"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayOwnerControlMetadata.d.ts",
        default: "./dist/browserGatewayOwnerControlMetadata.js",
      },
      import: {
        types: "./dist/browserGatewayOwnerControlMetadata.d.ts",
        default: "./dist/browserGatewayOwnerControlMetadata.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayOwnerControlMetadata.d.cts",
        default: "./dist/cjs/browserGatewayOwnerControlMetadata.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayOwnerControlMetadata.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayOwnerControlMetadata.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayOwnerControlMetadata.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayOwnerControlMetadata.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayOwnerControlMetadata.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayOwnerControlMetadata.d.cts"),
        "utf8",
      ),
    ).toContain("export declare const BROWSER_GATEWAY_OWNER_CONTROL_KINDS");
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayOwnerControlMetadata.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    const ownerControlMetadataModule = requireFromBoundaryTest(
      "@agentlink/protocol/browser-gateway-owner-control-metadata",
    ) as {
      BROWSER_GATEWAY_OWNER_CONTROL_KINDS?: readonly string[];
      BROWSER_GATEWAY_RELAY_RESET_REASONS?: readonly string[];
    };
    expect(
      ownerControlMetadataModule.BROWSER_GATEWAY_OWNER_CONTROL_KINDS,
    ).toEqual([
      "hello",
      "demand.changed",
      "checkpoint.requested",
      "command.cancelled",
      "drain",
    ]);
    expect(
      ownerControlMetadataModule.BROWSER_GATEWAY_RELAY_RESET_REASONS,
    ).toEqual([
      "helper_generation_changed",
      "owner_generation_changed",
      "sequence_gap",
      "stale_replay_cursor",
      "subscription_changed",
      "checkpoint_required",
    ]);
    expect(
      Object.isFrozen(
        ownerControlMetadataModule.BROWSER_GATEWAY_OWNER_CONTROL_KINDS,
      ),
    ).toBe(false);
    expect(
      Object.isFrozen(
        ownerControlMetadataModule.BROWSER_GATEWAY_RELAY_RESET_REASONS,
      ),
    ).toBe(true);
    expect(() =>
      (
        ownerControlMetadataModule.BROWSER_GATEWAY_RELAY_RESET_REASONS as unknown as string[]
      ).push("other"),
    ).toThrow(TypeError);
  });

  it("wires browser-gateway owner-event metadata through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-owner-event-metadata"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayOwnerEventMetadata.d.ts",
        default: "./dist/browserGatewayOwnerEventMetadata.js",
      },
      import: {
        types: "./dist/browserGatewayOwnerEventMetadata.d.ts",
        default: "./dist/browserGatewayOwnerEventMetadata.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayOwnerEventMetadata.d.cts",
        default: "./dist/cjs/browserGatewayOwnerEventMetadata.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayOwnerEventMetadata.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayOwnerEventMetadata.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayOwnerEventMetadata.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayOwnerEventMetadata.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayOwnerEventMetadata.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayOwnerEventMetadata.d.cts"),
        "utf8",
      ),
    ).toContain("export declare const BROWSER_GATEWAY_OWNER_EVENT_KINDS");
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayOwnerEventMetadata.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    const ownerEventMetadataModule = requireFromBoundaryTest(
      "@agentlink/protocol/browser-gateway-owner-event-metadata",
    ) as { BROWSER_GATEWAY_OWNER_EVENT_KINDS?: readonly string[] };
    expect(ownerEventMetadataModule.BROWSER_GATEWAY_OWNER_EVENT_KINDS).toEqual([
      "foreground.control.updated",
      "session.catalog.updated",
      "transcript.message.appended",
      "transcript.message.upserted",
      "transcript.block.delta",
      "transcript.history.prepended",
      "interaction.updated",
      "queue.updated",
      "todo.updated",
      "background.updated",
      "fleet.updated",
      "diff.preview.updated",
      "repository.updated",
      "theme.updated",
      "model_catalog.revision.updated",
      "plugin_catalog.revision.updated",
      "owner.capabilities.updated",
      "operation.updated",
    ]);
    expect(
      Object.isFrozen(
        ownerEventMetadataModule.BROWSER_GATEWAY_OWNER_EVENT_KINDS,
      ),
    ).toBe(true);
    expect(() =>
      (
        ownerEventMetadataModule.BROWSER_GATEWAY_OWNER_EVENT_KINDS as unknown as string[]
      ).push("other"),
    ).toThrow(TypeError);
  });

  it("wires browser-gateway command metadata and operation state through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-owner-command-metadata"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayOwnerCommandMetadata.d.ts",
        default: "./dist/browserGatewayOwnerCommandMetadata.js",
      },
      import: {
        types: "./dist/browserGatewayOwnerCommandMetadata.d.ts",
        default: "./dist/browserGatewayOwnerCommandMetadata.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayOwnerCommandMetadata.d.cts",
        default: "./dist/cjs/browserGatewayOwnerCommandMetadata.cjs",
      },
    });
    expect(
      packageManifest.exports?.["./browser-gateway-operation-state"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayOperationState.d.ts",
        default: "./dist/browserGatewayOperationState.js",
      },
      import: {
        types: "./dist/browserGatewayOperationState.d.ts",
        default: "./dist/browserGatewayOperationState.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayOperationState.d.cts",
        default: "./dist/cjs/browserGatewayOperationState.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayOwnerCommandMetadata.js";',
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayOperationState.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      for (const moduleName of [
        "browserGatewayOperationState",
        "browserGatewayOwnerCommandMetadata",
      ]) {
        expect(source, buildScript).toContain(`"src/${moduleName}.ts"`);
        expect(source, buildScript).toContain(`"dist/cjs/${moduleName}.d.cts"`);
        expect(source, buildScript).toContain(
          `export * from "./${moduleName}.cjs";\\n`,
        );
      }
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /readFile\("dist\/browserGatewayOperationState\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayOperationState\.d\.cts", content \.replaceAll\(\s*'"\.\/browserGatewayDataPlaneIdentity\.js"'\s*,\s*'"\.\/browserGatewayDataPlaneIdentity\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/browserGatewayOwnerCommandMetadata\.js"'\s*,\s*'"\.\/browserGatewayOwnerCommandMetadata\.cjs"'\s*,?\s*\), \), \)/,
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    const cjsIndex = fs.readFileSync(
      path.join(cjsDirectory, "index.d.cts"),
      "utf8",
    );
    expect(cjsIndex).toContain(
      'export * from "./browserGatewayOwnerCommandMetadata.cjs";',
    );
    expect(cjsIndex).toContain(
      'export * from "./browserGatewayOperationState.cjs";',
    );
    const operationDeclaration = fs.readFileSync(
      path.join(cjsDirectory, "browserGatewayOperationState.d.cts"),
      "utf8",
    );
    expect(operationDeclaration).toContain(
      'from "./browserGatewayDataPlaneIdentity.cjs";',
    );
    expect(operationDeclaration).toContain(
      'from "./browserGatewayOwnerCommandMetadata.cjs";',
    );
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayOwnerCommandMetadata.cjs"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayOperationState.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-owner-command-metadata",
      ),
    ).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-operation-state",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-todo-item through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./browser-gateway-todo-item"]).toEqual({
      browser: {
        types: "./dist/browserGatewayTodoItem.d.ts",
        default: "./dist/browserGatewayTodoItem.js",
      },
      import: {
        types: "./dist/browserGatewayTodoItem.d.ts",
        default: "./dist/browserGatewayTodoItem.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayTodoItem.d.cts",
        default: "./dist/cjs/browserGatewayTodoItem.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayTodoItem.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/browserGatewayTodoItem.ts"');
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayTodoItem.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayTodoItem.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayTodoItem.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayTodoItem.d.cts"),
        "utf8",
      ),
    ).toContain("export interface BrowserGatewayTodoItem");
    const todoModule = requireFromBoundaryTest(
      "@agentlink/protocol/browser-gateway-todo-item",
    ) as { BROWSER_GATEWAY_TODO_ITEM_STATES?: readonly string[] };
    expect(todoModule.BROWSER_GATEWAY_TODO_ITEM_STATES).toEqual([
      "pending",
      "in_progress",
      "completed",
    ]);
    expect(Object.isFrozen(todoModule.BROWSER_GATEWAY_TODO_ITEM_STATES)).toBe(
      true,
    );
    expect(() =>
      (todoModule.BROWSER_GATEWAY_TODO_ITEM_STATES as unknown as string[]).push(
        "other",
      ),
    ).toThrow(TypeError);
  });

  it("wires browser-gateway-queue-item through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./browser-gateway-queue-item"]).toEqual({
      browser: {
        types: "./dist/browserGatewayQueueItem.d.ts",
        default: "./dist/browserGatewayQueueItem.js",
      },
      import: {
        types: "./dist/browserGatewayQueueItem.d.ts",
        default: "./dist/browserGatewayQueueItem.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayQueueItem.d.cts",
        default: "./dist/cjs/browserGatewayQueueItem.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayQueueItem.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/browserGatewayQueueItem.ts"');
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayQueueItem.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayQueueItem.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayQueueItem.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayQueueItem.d.cts"),
        "utf8",
      ),
    ).toContain("export interface BrowserGatewayQueueItem");
    const queueModule = requireFromBoundaryTest(
      "@agentlink/protocol/browser-gateway-queue-item",
    ) as { BROWSER_GATEWAY_QUEUE_ITEM_STATES?: readonly string[] };
    expect(queueModule.BROWSER_GATEWAY_QUEUE_ITEM_STATES).toEqual([
      "queued",
      "running",
      "completed",
      "failed",
    ]);
    expect(Object.isFrozen(queueModule.BROWSER_GATEWAY_QUEUE_ITEM_STATES)).toBe(
      true,
    );
    expect(() =>
      (
        queueModule.BROWSER_GATEWAY_QUEUE_ITEM_STATES as unknown as string[]
      ).push("other"),
    ).toThrow(TypeError);
  });

  it("wires browser-gateway-repository-state through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-repository-state"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayRepositoryState.d.ts",
        default: "./dist/browserGatewayRepositoryState.js",
      },
      import: {
        types: "./dist/browserGatewayRepositoryState.d.ts",
        default: "./dist/browserGatewayRepositoryState.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayRepositoryState.d.cts",
        default: "./dist/cjs/browserGatewayRepositoryState.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayRepositoryState.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayRepositoryState.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayRepositoryState.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayRepositoryState.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayRepositoryState.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayRepositoryState.d.cts"),
        "utf8",
      ),
    ).toContain("export interface BrowserGatewayRepositoryState");
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayRepositoryState.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-repository-state",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-context-budget through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-context-budget"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayContextBudget.d.ts",
        default: "./dist/browserGatewayContextBudget.js",
      },
      import: {
        types: "./dist/browserGatewayContextBudget.d.ts",
        default: "./dist/browserGatewayContextBudget.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayContextBudget.d.cts",
        default: "./dist/cjs/browserGatewayContextBudget.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayContextBudget.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayContextBudget.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayContextBudget.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayContextBudget.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayContextBudget.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayContextBudget.d.cts"),
        "utf8",
      ),
    ).toContain("export interface BrowserGatewayContextBudget");
    expect(
      fs.existsSync(path.join(cjsDirectory, "browserGatewayContextBudget.cjs")),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-context-budget",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-capability-status through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-capability-status"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayCapabilityStatus.d.ts",
        default: "./dist/browserGatewayCapabilityStatus.js",
      },
      import: {
        types: "./dist/browserGatewayCapabilityStatus.d.ts",
        default: "./dist/browserGatewayCapabilityStatus.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayCapabilityStatus.d.cts",
        default: "./dist/cjs/browserGatewayCapabilityStatus.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayCapabilityStatus.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayCapabilityStatus.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayCapabilityStatus.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayCapabilityStatus.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayCapabilityStatus.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayCapabilityStatus.d.cts"),
        "utf8",
      ),
    ).toContain("export interface BrowserGatewayCapabilityStatus");
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayCapabilityStatus.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    const capabilityModule = requireFromBoundaryTest(
      "@agentlink/protocol/browser-gateway-capability-status",
    ) as { BROWSER_GATEWAY_CAPABILITY_STATES?: readonly string[] };
    expect(capabilityModule.BROWSER_GATEWAY_CAPABILITY_STATES).toEqual([
      "enabled",
      "disabled",
      "requires_approval",
      "unavailable",
    ]);
    expect(
      Object.isFrozen(capabilityModule.BROWSER_GATEWAY_CAPABILITY_STATES),
    ).toBe(true);
    expect(() =>
      (
        capabilityModule.BROWSER_GATEWAY_CAPABILITY_STATES as unknown as string[]
      ).push("other"),
    ).toThrow(TypeError);
  });

  it("wires browser-gateway-protocol-error through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-protocol-error"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayProtocolError.d.ts",
        default: "./dist/browserGatewayProtocolError.js",
      },
      import: {
        types: "./dist/browserGatewayProtocolError.d.ts",
        default: "./dist/browserGatewayProtocolError.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayProtocolError.d.cts",
        default: "./dist/cjs/browserGatewayProtocolError.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayProtocolError.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayProtocolError.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayProtocolError.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayProtocolError.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayProtocolError.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayProtocolError.d.cts"),
        "utf8",
      ),
    ).toContain(
      "export declare class BrowserGatewayProtocolError extends Error",
    );
    type ProtocolErrorConstructor = new (
      code: "invalid_value",
      path: string,
      message: string,
    ) => Error & { code: string; path: string };
    const protocolErrorModule = requireFromBoundaryTest(
      "@agentlink/protocol/browser-gateway-protocol-error",
    ) as { BrowserGatewayProtocolError: ProtocolErrorConstructor };
    const rootProtocolModule = requireFromBoundaryTest(
      "@agentlink/protocol",
    ) as { BrowserGatewayProtocolError: ProtocolErrorConstructor };
    for (const constructor of [
      protocolErrorModule.BrowserGatewayProtocolError,
      rootProtocolModule.BrowserGatewayProtocolError,
    ]) {
      const error = new constructor(
        "invalid_value",
        "$.field",
        "must be valid",
      );
      expect(error).toBeInstanceOf(constructor);
      expect(error).toMatchObject({
        name: "BrowserGatewayProtocolError",
        code: "invalid_value",
        path: "$.field",
        message: "$.field: must be valid",
      });
    }
  });

  it("wires browser-gateway-owner-publication-batch through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-owner-publication-batch"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayOwnerPublicationBatch.d.ts",
        default: "./dist/browserGatewayOwnerPublicationBatch.js",
      },
      import: {
        types: "./dist/browserGatewayOwnerPublicationBatch.d.ts",
        default: "./dist/browserGatewayOwnerPublicationBatch.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayOwnerPublicationBatch.d.cts",
        default: "./dist/cjs/browserGatewayOwnerPublicationBatch.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayOwnerPublicationBatch.js";',
    );

    const dependencies = [
      "browserGatewayDataPlaneIdentity",
      "browserGatewayDataPlaneVersion",
      "browserGatewayOwnerCheckpoint",
      "browserGatewayOwnerEvent",
    ] as const;
    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayOwnerPublicationBatch.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayOwnerPublicationBatch.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayOwnerPublicationBatch.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      for (const dependency of dependencies) {
        expect(normalizedSource, `${buildScript}:${dependency}`).toMatch(
          new RegExp(
            `\\.replaceAll\\(\\s*'"\\.\\/${dependency}\\.js"'\\s*,\\s*'"\\.\\/${dependency}\\.cjs"'\\s*,?\\s*\\)`,
          ),
        );
      }
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayOwnerPublicationBatch.cjs";');
    const declaration = fs.readFileSync(
      path.join(cjsDirectory, "browserGatewayOwnerPublicationBatch.d.cts"),
      "utf8",
    );
    for (const dependency of dependencies) {
      expect(declaration).toContain(`from "./${dependency}.cjs";`);
    }
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayOwnerPublicationBatch.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-owner-publication-batch",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-owner-checkpoint through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-owner-checkpoint"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayOwnerCheckpoint.d.ts",
        default: "./dist/browserGatewayOwnerCheckpoint.js",
      },
      import: {
        types: "./dist/browserGatewayOwnerCheckpoint.d.ts",
        default: "./dist/browserGatewayOwnerCheckpoint.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayOwnerCheckpoint.d.cts",
        default: "./dist/cjs/browserGatewayOwnerCheckpoint.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayOwnerCheckpoint.js";',
    );

    const dependencies = [
      "browserGatewayBackgroundSummary",
      "browserGatewayCapabilityStatus",
      "browserGatewayDataPlaneIdentity",
      "browserGatewayDataPlaneVersion",
      "browserGatewayDiffPreview",
      "browserGatewayForegroundControlState",
      "browserGatewayInteractionState",
      "browserGatewayRepositoryState",
      "browserGatewaySessionCatalog",
      "browserGatewayTheme",
      "browserGatewayTranscriptWindow",
    ] as const;
    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayOwnerCheckpoint.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayOwnerCheckpoint.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayOwnerCheckpoint.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      for (const dependency of dependencies) {
        expect(normalizedSource, `${buildScript}:${dependency}`).toMatch(
          new RegExp(
            `\\.replaceAll\\(\\s*'"\\.\\/${dependency}\\.js"'\\s*,\\s*'"\\.\\/${dependency}\\.cjs"'\\s*,?\\s*\\)`,
          ),
        );
      }
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayOwnerCheckpoint.cjs";');
    const declaration = fs.readFileSync(
      path.join(cjsDirectory, "browserGatewayOwnerCheckpoint.d.cts"),
      "utf8",
    );
    for (const dependency of dependencies) {
      expect(declaration).toContain(`from "./${dependency}.cjs";`);
    }
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayOwnerCheckpoint.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-owner-checkpoint",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-owner-event through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./browser-gateway-owner-event"]).toEqual({
      browser: {
        types: "./dist/browserGatewayOwnerEvent.d.ts",
        default: "./dist/browserGatewayOwnerEvent.js",
      },
      import: {
        types: "./dist/browserGatewayOwnerEvent.d.ts",
        default: "./dist/browserGatewayOwnerEvent.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayOwnerEvent.d.cts",
        default: "./dist/cjs/browserGatewayOwnerEvent.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayOwnerEvent.js";',
    );

    const dependencies = [
      "browserGatewayBackgroundSummary",
      "browserGatewayCapabilityStatus",
      "browserGatewayDataPlaneIdentity",
      "browserGatewayDataPlaneVersion",
      "browserGatewayDiffPreview",
      "browserGatewayForegroundControlState",
      "browserGatewayInteractionSummary",
      "browserGatewayOperationState",
      "browserGatewayOwnerEventMetadata",
      "browserGatewayQueueItem",
      "browserGatewayRepositoryState",
      "browserGatewaySessionCatalog",
      "browserGatewayTheme",
      "browserGatewayTodoItem",
      "browserGatewayTranscriptMessage",
      "browserGatewayTranscriptWindow",
    ] as const;
    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayOwnerEvent.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayOwnerEvent.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayOwnerEvent.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      for (const dependency of dependencies) {
        expect(normalizedSource, `${buildScript}:${dependency}`).toMatch(
          new RegExp(
            `\\.replaceAll\\(\\s*'"\\.\\/${dependency}\\.js"'\\s*,\\s*'"\\.\\/${dependency}\\.cjs"'\\s*,?\\s*\\)`,
          ),
        );
      }
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayOwnerEvent.cjs";');
    const declaration = fs.readFileSync(
      path.join(cjsDirectory, "browserGatewayOwnerEvent.d.cts"),
      "utf8",
    );
    for (const dependency of dependencies) {
      expect(declaration).toContain(`from "./${dependency}.cjs";`);
    }
    expect(
      fs.existsSync(path.join(cjsDirectory, "browserGatewayOwnerEvent.cjs")),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-owner-event",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-owner-control through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-owner-control"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayOwnerControl.d.ts",
        default: "./dist/browserGatewayOwnerControl.js",
      },
      import: {
        types: "./dist/browserGatewayOwnerControl.d.ts",
        default: "./dist/browserGatewayOwnerControl.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayOwnerControl.d.cts",
        default: "./dist/cjs/browserGatewayOwnerControl.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayOwnerControl.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayOwnerControl.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayOwnerControl.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayOwnerControl.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      for (const dependency of [
        "browserGatewayDataPlaneIdentity",
        "browserGatewayDataPlaneVersion",
        "browserGatewayOwnerControlMetadata",
      ]) {
        expect(normalizedSource, `${buildScript}:${dependency}`).toMatch(
          new RegExp(
            `\\.replaceAll\\(\\s*'"\\.\\/${dependency}\\.js"'\\s*,\\s*'"\\.\\/${dependency}\\.cjs"'\\s*,?\\s*\\)`,
          ),
        );
      }
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayOwnerControl.cjs";');
    const declaration = fs.readFileSync(
      path.join(cjsDirectory, "browserGatewayOwnerControl.d.cts"),
      "utf8",
    );
    for (const dependency of [
      "browserGatewayDataPlaneIdentity",
      "browserGatewayDataPlaneVersion",
      "browserGatewayOwnerControlMetadata",
    ]) {
      expect(declaration).toContain(`from "./${dependency}.cjs";`);
    }
    expect(
      fs.existsSync(path.join(cjsDirectory, "browserGatewayOwnerControl.cjs")),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-owner-control",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-owner-command-ack through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-owner-command-ack"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayOwnerCommandAck.d.ts",
        default: "./dist/browserGatewayOwnerCommandAck.js",
      },
      import: {
        types: "./dist/browserGatewayOwnerCommandAck.d.ts",
        default: "./dist/browserGatewayOwnerCommandAck.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayOwnerCommandAck.d.cts",
        default: "./dist/cjs/browserGatewayOwnerCommandAck.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayOwnerCommandAck.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayOwnerCommandAck.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayOwnerCommandAck.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayOwnerCommandAck.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      for (const dependency of [
        "browserGatewayDataPlaneIdentity",
        "browserGatewayDataPlaneVersion",
        "browserGatewayOperationState",
      ]) {
        expect(normalizedSource, `${buildScript}:${dependency}`).toMatch(
          new RegExp(
            `\\.replaceAll\\(\\s*'"\\.\\/${dependency}\\.js"'\\s*,\\s*'"\\.\\/${dependency}\\.cjs"'\\s*,?\\s*\\)`,
          ),
        );
      }
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayOwnerCommandAck.cjs";');
    const declaration = fs.readFileSync(
      path.join(cjsDirectory, "browserGatewayOwnerCommandAck.d.cts"),
      "utf8",
    );
    for (const dependency of [
      "browserGatewayDataPlaneIdentity",
      "browserGatewayDataPlaneVersion",
      "browserGatewayOperationState",
    ]) {
      expect(declaration).toContain(`from "./${dependency}.cjs";`);
    }
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayOwnerCommandAck.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-owner-command-ack",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-owner-command through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-owner-command"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayOwnerCommand.d.ts",
        default: "./dist/browserGatewayOwnerCommand.js",
      },
      import: {
        types: "./dist/browserGatewayOwnerCommand.d.ts",
        default: "./dist/browserGatewayOwnerCommand.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayOwnerCommand.d.cts",
        default: "./dist/cjs/browserGatewayOwnerCommand.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayOwnerCommand.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayOwnerCommand.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayOwnerCommand.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayOwnerCommand.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      for (const dependency of [
        "browserGatewayDataPlaneIdentity",
        "browserGatewayDataPlaneVersion",
        "browserGatewayOwnerCommandBody",
        "browserGatewayOwnerCommandMetadata",
      ]) {
        expect(normalizedSource, `${buildScript}:${dependency}`).toMatch(
          new RegExp(
            `\\.replaceAll\\(\\s*'"\\.\\/${dependency}\\.js"'\\s*,\\s*'"\\.\\/${dependency}\\.cjs"'\\s*,?\\s*\\)`,
          ),
        );
      }
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayOwnerCommand.cjs";');
    const declaration = fs.readFileSync(
      path.join(cjsDirectory, "browserGatewayOwnerCommand.d.cts"),
      "utf8",
    );
    for (const dependency of [
      "browserGatewayDataPlaneIdentity",
      "browserGatewayDataPlaneVersion",
      "browserGatewayOwnerCommandBody",
      "browserGatewayOwnerCommandMetadata",
    ]) {
      expect(declaration).toContain(`from "./${dependency}.cjs";`);
    }
    expect(
      fs.existsSync(path.join(cjsDirectory, "browserGatewayOwnerCommand.cjs")),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-owner-command",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-owner-command-body through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-owner-command-body"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayOwnerCommandBody.d.ts",
        default: "./dist/browserGatewayOwnerCommandBody.js",
      },
      import: {
        types: "./dist/browserGatewayOwnerCommandBody.d.ts",
        default: "./dist/browserGatewayOwnerCommandBody.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayOwnerCommandBody.d.cts",
        default: "./dist/cjs/browserGatewayOwnerCommandBody.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayOwnerCommandBody.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayOwnerCommandBody.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayOwnerCommandBody.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayOwnerCommandBody.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /readFile\("dist\/browserGatewayOwnerCommandBody\.d\.ts", "utf8"\)\.then\(\s*(?:\(content\)|content) =>\s*writeFile\( "dist\/cjs\/browserGatewayOwnerCommandBody\.d\.cts", content\.replaceAll\(\s*'"\.\/browserGatewayDataPlaneIdentity\.js"'\s*,\s*'"\.\/browserGatewayDataPlaneIdentity\.cjs"'\s*,?\s*\), \), \)/,
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayOwnerCommandBody.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayOwnerCommandBody.d.cts"),
        "utf8",
      ),
    ).toContain(
      'import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.cjs";',
    );
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayOwnerCommandBody.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-owner-command-body",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-foreground-control-state through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-foreground-control-state"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayForegroundControlState.d.ts",
        default: "./dist/browserGatewayForegroundControlState.js",
      },
      import: {
        types: "./dist/browserGatewayForegroundControlState.d.ts",
        default: "./dist/browserGatewayForegroundControlState.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayForegroundControlState.d.cts",
        default: "./dist/cjs/browserGatewayForegroundControlState.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayForegroundControlState.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayForegroundControlState.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayForegroundControlState.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayForegroundControlState.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      for (const dependency of [
        "terminal",
        "browserGatewayContextBudget",
        "chatWorkspace",
        "commandApprovalPolicy",
        "contextHealth",
        "modelCatalog",
        "sessionHydration",
      ]) {
        expect(normalizedSource, `${buildScript}:${dependency}`).toMatch(
          new RegExp(
            `\\.replaceAll\\(\\s*'"\\.\\/${dependency}\\.js"'\\s*,\\s*'"\\.\\/${dependency}\\.cjs"'\\s*,?\\s*\\)`,
          ),
        );
      }
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayForegroundControlState.cjs";');
    const declaration = fs.readFileSync(
      path.join(cjsDirectory, "browserGatewayForegroundControlState.d.cts"),
      "utf8",
    );
    for (const dependency of [
      "terminal",
      "browserGatewayContextBudget",
      "chatWorkspace",
      "commandApprovalPolicy",
      "contextHealth",
      "modelCatalog",
      "sessionHydration",
    ]) {
      expect(declaration).toContain(`from "./${dependency}.cjs";`);
    }
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayForegroundControlState.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-foreground-control-state",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-session-catalog through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-session-catalog"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewaySessionCatalog.d.ts",
        default: "./dist/browserGatewaySessionCatalog.js",
      },
      import: {
        types: "./dist/browserGatewaySessionCatalog.d.ts",
        default: "./dist/browserGatewaySessionCatalog.js",
      },
      require: {
        types: "./dist/cjs/browserGatewaySessionCatalog.d.cts",
        default: "./dist/cjs/browserGatewaySessionCatalog.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewaySessionCatalog.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewaySessionCatalog.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewaySessionCatalog.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewaySessionCatalog.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /readFile\("dist\/browserGatewaySessionCatalog\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewaySessionCatalog\.d\.cts", content\.replaceAll\(\s*'"\.\/browserGatewayChatWorkspaceSummary\.js"'\s*,\s*'"\.\/browserGatewayChatWorkspaceSummary\.cjs"'\s*,?\s*\), \), \)/,
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewaySessionCatalog.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewaySessionCatalog.d.cts"),
        "utf8",
      ),
    ).toContain(
      'import type { BrowserGatewayChatWorkspaceSummary } from "./browserGatewayChatWorkspaceSummary.cjs";',
    );
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewaySessionCatalog.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-session-catalog",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-chat-workspace-summary through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-chat-workspace-summary"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayChatWorkspaceSummary.d.ts",
        default: "./dist/browserGatewayChatWorkspaceSummary.js",
      },
      import: {
        types: "./dist/browserGatewayChatWorkspaceSummary.d.ts",
        default: "./dist/browserGatewayChatWorkspaceSummary.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayChatWorkspaceSummary.d.cts",
        default: "./dist/cjs/browserGatewayChatWorkspaceSummary.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayChatWorkspaceSummary.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayChatWorkspaceSummary.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayChatWorkspaceSummary.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayChatWorkspaceSummary.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /readFile\(\s*"dist\/browserGatewayChatWorkspaceSummary\.d\.ts",\s*"utf8",?\s*\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayChatWorkspaceSummary\.d\.cts", content\.replaceAll\(\s*'"\.\/chatWorkspace\.js"'\s*,\s*'"\.\/chatWorkspace\.cjs"'\s*,?\s*\), \), \)/,
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayChatWorkspaceSummary.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayChatWorkspaceSummary.d.cts"),
        "utf8",
      ),
    ).toContain(
      'import type { ChatWorkspaceInteractiveExecutionPhase } from "./chatWorkspace.cjs";',
    );
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayChatWorkspaceSummary.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-chat-workspace-summary",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-data-plane-version through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-data-plane-version"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayDataPlaneVersion.d.ts",
        default: "./dist/browserGatewayDataPlaneVersion.js",
      },
      import: {
        types: "./dist/browserGatewayDataPlaneVersion.d.ts",
        default: "./dist/browserGatewayDataPlaneVersion.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayDataPlaneVersion.d.cts",
        default: "./dist/cjs/browserGatewayDataPlaneVersion.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayDataPlaneVersion.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayDataPlaneVersion.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayDataPlaneVersion.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayDataPlaneVersion.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayDataPlaneVersion.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayDataPlaneVersion.d.cts"),
        "utf8",
      ),
    ).toContain(
      'export declare const BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION = "1";',
    );
    const versionModule = requireFromBoundaryTest(
      "@agentlink/protocol/browser-gateway-data-plane-version",
    ) as { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION?: string };
    expect(versionModule.BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION).toBe("1");
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
  });

  it("wires browser-gateway-data-plane-identity through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-data-plane-identity"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayDataPlaneIdentity.d.ts",
        default: "./dist/browserGatewayDataPlaneIdentity.js",
      },
      import: {
        types: "./dist/browserGatewayDataPlaneIdentity.d.ts",
        default: "./dist/browserGatewayDataPlaneIdentity.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayDataPlaneIdentity.d.cts",
        default: "./dist/cjs/browserGatewayDataPlaneIdentity.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayDataPlaneIdentity.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayDataPlaneIdentity.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayDataPlaneIdentity.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayDataPlaneIdentity.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayDataPlaneIdentity.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayDataPlaneIdentity.d.cts"),
        "utf8",
      ),
    ).toContain("export interface BrowserGatewayDetailHandle");
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayDataPlaneIdentity.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    const identityModule = requireFromBoundaryTest(
      "@agentlink/protocol/browser-gateway-data-plane-identity",
    ) as { BROWSER_GATEWAY_DETAIL_HANDLE_KINDS?: readonly string[] };
    expect(identityModule.BROWSER_GATEWAY_DETAIL_HANDLE_KINDS).toEqual([
      "message",
      "diff",
      "media",
      "interaction",
      "session",
    ]);
    expect(
      Object.isFrozen(identityModule.BROWSER_GATEWAY_DETAIL_HANDLE_KINDS),
    ).toBe(true);
    expect(() =>
      (
        identityModule.BROWSER_GATEWAY_DETAIL_HANDLE_KINDS as unknown as string[]
      ).push("other"),
    ).toThrow(TypeError);
  });

  it("keeps every generated CJS declaration free of relative ESM specifiers", () => {
    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    const staleSpecifiers = fs
      .readdirSync(cjsDirectory)
      .filter((fileName) => fileName.endsWith(".d.cts"))
      .flatMap((fileName) => {
        const source = fs.readFileSync(
          path.join(cjsDirectory, fileName),
          "utf8",
        );
        return [...source.matchAll(/["'](\.\.?\/[^"']+\.js)["']/g)].map(
          (match) => `${fileName}: ${match[1]}`,
        );
      });
    expect(staleSpecifiers).toEqual([]);
  });

  it("wires browser-gateway-instance-status through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-instance-status"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayInstanceStatus.d.ts",
        default: "./dist/browserGatewayInstanceStatus.js",
      },
      import: {
        types: "./dist/browserGatewayInstanceStatus.d.ts",
        default: "./dist/browserGatewayInstanceStatus.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayInstanceStatus.d.cts",
        default: "./dist/cjs/browserGatewayInstanceStatus.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayInstanceStatus.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayInstanceStatus.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayInstanceStatus.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayInstanceStatus.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayInstanceStatus.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayInstanceStatus.d.cts"),
        "utf8",
      ),
    ).toContain("export interface BrowserGatewayInstanceStatusSummary");
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayInstanceStatus.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-instance-status",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-model-provider-identity through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-model-provider-identity"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayModelProviderIdentity.d.ts",
        default: "./dist/browserGatewayModelProviderIdentity.js",
      },
      import: {
        types: "./dist/browserGatewayModelProviderIdentity.d.ts",
        default: "./dist/browserGatewayModelProviderIdentity.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayModelProviderIdentity.d.cts",
        default: "./dist/cjs/browserGatewayModelProviderIdentity.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayModelProviderIdentity.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayModelProviderIdentity.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayModelProviderIdentity.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayModelProviderIdentity.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayModelProviderIdentity.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayModelProviderIdentity.d.cts"),
        "utf8",
      ),
    ).toContain(
      "export declare function normalizeBrowserGatewayModelCredentialProviderId",
    );
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayModelProviderIdentity.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-model-provider-identity",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-data-plane-limits through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-data-plane-limits"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayDataPlaneLimits.d.ts",
        default: "./dist/browserGatewayDataPlaneLimits.js",
      },
      import: {
        types: "./dist/browserGatewayDataPlaneLimits.d.ts",
        default: "./dist/browserGatewayDataPlaneLimits.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayDataPlaneLimits.d.cts",
        default: "./dist/cjs/browserGatewayDataPlaneLimits.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayDataPlaneLimits.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayDataPlaneLimits.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayDataPlaneLimits.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayDataPlaneLimits.cjs";\\n',
      );
      const normalizedSource = source.replace(/\s+/g, " ");
      expect(normalizedSource, buildScript).toMatch(
        /readFile\("dist\/browserGatewayDataPlaneLimits\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayDataPlaneLimits\.d\.cts", content \.replaceAll\(\s*'"\.\/browserGatewayDataPlaneIdentity\.js"'\s*,\s*'"\.\/browserGatewayDataPlaneIdentity\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/browserGatewayOwnerCommandMetadata\.js"'\s*,\s*'"\.\/browserGatewayOwnerCommandMetadata\.cjs"'\s*,?\s*\), \), \)/,
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayDataPlaneLimits.cjs";');
    const limitsDeclaration = fs.readFileSync(
      path.join(cjsDirectory, "browserGatewayDataPlaneLimits.d.cts"),
      "utf8",
    );
    expect(limitsDeclaration).toContain(
      'from "./browserGatewayDataPlaneIdentity.cjs";',
    );
    expect(limitsDeclaration).toContain(
      "export type BrowserGatewayDataPlaneLimitName",
    );
    expect(
      fs.existsSync(
        path.join(cjsDirectory, "browserGatewayDataPlaneLimits.cjs"),
      ),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-data-plane-limits",
      ),
    ).not.toThrow();
  });

  it("wires browser-gateway-data-plane-mode through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(
      packageManifest.exports?.["./browser-gateway-data-plane-mode"],
    ).toEqual({
      browser: {
        types: "./dist/browserGatewayDataPlaneMode.d.ts",
        default: "./dist/browserGatewayDataPlaneMode.js",
      },
      import: {
        types: "./dist/browserGatewayDataPlaneMode.d.ts",
        default: "./dist/browserGatewayDataPlaneMode.js",
      },
      require: {
        types: "./dist/cjs/browserGatewayDataPlaneMode.d.cts",
        default: "./dist/cjs/browserGatewayDataPlaneMode.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./browserGatewayDataPlaneMode.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/browserGatewayDataPlaneMode.ts"',
      );
      expect(source, buildScript).toContain(
        '"dist/cjs/browserGatewayDataPlaneMode.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./browserGatewayDataPlaneMode.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./browserGatewayDataPlaneMode.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "browserGatewayDataPlaneMode.d.cts"),
        "utf8",
      ),
    ).toContain("export type BrowserGatewayDataPlaneMode");
    expect(
      fs.existsSync(path.join(cjsDirectory, "browserGatewayDataPlaneMode.cjs")),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest(
        "@agentlink/protocol/browser-gateway-data-plane-mode",
      ),
    ).not.toThrow();
  });

  it("wires surface-model-message through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./surface-model-message"]).toEqual({
      browser: {
        types: "./dist/surfaceModelMessage.d.ts",
        default: "./dist/surfaceModelMessage.js",
      },
      import: {
        types: "./dist/surfaceModelMessage.d.ts",
        default: "./dist/surfaceModelMessage.js",
      },
      require: {
        types: "./dist/cjs/surfaceModelMessage.d.cts",
        default: "./dist/cjs/surfaceModelMessage.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./surfaceModelMessage.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/surfaceModelMessage.ts"');
      expect(source, buildScript).toContain(
        '"dist/cjs/surfaceModelMessage.d.cts"',
      );
      expect(source, buildScript).toContain(
        'export * from "./surfaceModelMessage.cjs";\\n',
      );
    }

    const cjsDirectory = path.join(ROOT, "packages", "protocol", "dist", "cjs");
    expect(
      fs.readFileSync(path.join(cjsDirectory, "index.d.cts"), "utf8"),
    ).toContain('export * from "./surfaceModelMessage.cjs";');
    expect(
      fs.readFileSync(
        path.join(cjsDirectory, "surfaceModelMessage.d.cts"),
        "utf8",
      ),
    ).toContain("export interface CoreSurfaceModelMessage");
    expect(
      fs.existsSync(path.join(cjsDirectory, "surfaceModelMessage.cjs")),
    ).toBe(true);
    expect(() => requireFromBoundaryTest("@agentlink/protocol")).not.toThrow();
    expect(() =>
      requireFromBoundaryTest("@agentlink/protocol/surface-model-message"),
    ).not.toThrow();
  });

  it("wires terminal-security through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./terminal-security"]).toEqual({
      browser: {
        types: "./dist/terminalSecurity.d.ts",
        default: "./dist/terminalSecurity.js",
      },
      import: {
        types: "./dist/terminalSecurity.d.ts",
        default: "./dist/terminalSecurity.js",
      },
      require: {
        types: "./dist/cjs/terminalSecurity.d.cts",
        default: "./dist/cjs/terminalSecurity.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./terminalSecurity.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/terminalSecurity.ts"');
      expect(source, buildScript).toContain(
        '"dist/cjs/terminalSecurity.d.cts"',
      );
      expect(source, buildScript).toContain('"./terminalSecurity.cjs"');
    }
  });

  it("wires terminal-surface through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./terminal-surface"]).toEqual({
      browser: {
        types: "./dist/terminalSurface.d.ts",
        default: "./dist/terminalSurface.js",
      },
      import: {
        types: "./dist/terminalSurface.d.ts",
        default: "./dist/terminalSurface.js",
      },
      require: {
        types: "./dist/cjs/terminalSurface.d.cts",
        default: "./dist/cjs/terminalSurface.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./terminalSurface.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/terminalSurface.ts"');
      expect(source, buildScript).toContain('"dist/cjs/terminalSurface.d.cts"');
      expect(source, buildScript).toContain('"./terminalSurface.cjs"');
    }
  });

  it("wires diff-snapshot through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./diff-snapshot"]).toEqual({
      browser: {
        types: "./dist/diffSnapshot.d.ts",
        default: "./dist/diffSnapshot.js",
      },
      import: {
        types: "./dist/diffSnapshot.d.ts",
        default: "./dist/diffSnapshot.js",
      },
      require: {
        types: "./dist/cjs/diffSnapshot.d.cts",
        default: "./dist/cjs/diffSnapshot.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./diffSnapshot.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/diffSnapshot.ts"');
      expect(source, buildScript).toContain('"dist/cjs/diffSnapshot.d.cts"');
      expect(source, buildScript).toContain('"./diffSnapshot.cjs"');
    }
  });

  it("wires embedded-agent transport through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./embedded-agent-presentation"]).toEqual({
      browser: {
        types: "./dist/embeddedAgentPresentation.d.ts",
        default: "./dist/embeddedAgentPresentation.js",
      },
      import: {
        types: "./dist/embeddedAgentPresentation.d.ts",
        default: "./dist/embeddedAgentPresentation.js",
      },
      require: {
        types: "./dist/cjs/embeddedAgentPresentation.d.cts",
        default: "./dist/cjs/embeddedAgentPresentation.cjs",
      },
    });
    expect(packageManifest.exports?.["./embedded-agent-transport"]).toEqual({
      browser: {
        types: "./dist/embeddedAgentTransport.d.ts",
        default: "./dist/embeddedAgentTransport.js",
      },
      import: {
        types: "./dist/embeddedAgentTransport.d.ts",
        default: "./dist/embeddedAgentTransport.js",
      },
      require: {
        types: "./dist/cjs/embeddedAgentTransport.d.cts",
        default: "./dist/cjs/embeddedAgentTransport.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain(
      'export * from "./embeddedAgentPresentation.js";',
    );
    expect(indexSource).toContain(
      'export * from "./embeddedAgentTransport.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain(
        '"src/embeddedAgentPresentation.ts"',
      );
      expect(source, buildScript).toContain('"src/embeddedAgentTransport.ts"');
      expect(source, buildScript).toContain(
        '"dist/cjs/embeddedAgentTransport.d.cts"',
      );
      expect(source, buildScript).toContain('"./embeddedAgentTransport.cjs"');
    }
  });

  it("wires chat-pane-transport through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./chat-pane-transport"]).toEqual({
      browser: {
        types: "./dist/chatPaneTransport.d.ts",
        default: "./dist/chatPaneTransport.js",
      },
      import: {
        types: "./dist/chatPaneTransport.d.ts",
        default: "./dist/chatPaneTransport.js",
      },
      require: {
        types: "./dist/cjs/chatPaneTransport.d.cts",
        default: "./dist/cjs/chatPaneTransport.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./chatPaneTransport.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/chatPaneTransport.ts"');
      expect(source, buildScript).toContain(
        '"dist/cjs/chatPaneTransport.d.cts"',
      );
      expect(source, buildScript).toContain('"./chatPaneTransport.cjs"');
    }
  });

  it("wires find-replace-preview through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports?.["./find-replace-preview"]).toEqual({
      browser: {
        types: "./dist/findReplacePreview.d.ts",
        default: "./dist/findReplacePreview.js",
      },
      import: {
        types: "./dist/findReplacePreview.d.ts",
        default: "./dist/findReplacePreview.js",
      },
      require: {
        types: "./dist/cjs/findReplacePreview.d.cts",
        default: "./dist/cjs/findReplacePreview.cjs",
      },
    });

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain("`findReplacePreview` is subpath-only");
    expect(indexSource).not.toContain(
      'export * from "./findReplacePreview.js";',
    );

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/findReplacePreview.ts"');
      expect(source, buildScript).toContain(
        '"dist/cjs/findReplacePreview.d.cts"',
      );
    }
  });

  it("wires chat-state through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports).toHaveProperty("./chat-state");

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./chatState.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/chatState.ts"');
      expect(source, buildScript).toContain('"dist/cjs/chatState.d.cts"');
      expect(source, buildScript).toContain('"./chatState.cjs"');
    }
  });

  it("wires chat-session-history through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports).toHaveProperty("./chat-session-history");

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./chatSessionHistory.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/chatSessionHistory.ts"');
      expect(source, buildScript).toContain(
        '"dist/cjs/chatSessionHistory.d.cts"',
      );
      expect(source, buildScript).toContain('"./chatSessionHistory.cjs"');
    }
  });

  it("wires chat-transcript through every public package build surface", () => {
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "packages", "protocol", "package.json"),
        "utf8",
      ),
    ) as { exports?: Record<string, unknown> };
    expect(packageManifest.exports).toHaveProperty("./chat-transcript");

    const indexSource = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain('export * from "./chatTranscript.js";');

    for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
      const source = fs.readFileSync(
        path.join(ROOT, "packages", "protocol", buildScript),
        "utf8",
      );
      expect(source, buildScript).toContain('"src/chatTranscript.ts"');
      expect(source, buildScript).toContain('"dist/cjs/chatTranscript.d.cts"');
      expect(source, buildScript).toContain('"./chatTranscript.cjs"');
    }
  });

  it("keeps autonomous-memory subpath-only to avoid the root MemoryScope collision", () => {
    const source = fs.readFileSync(
      path.join(PROTOCOL_SOURCE, "index.ts"),
      "utf8",
    );
    expect(source).toContain("`autonomousMemory` is subpath-only");
    expect(source).not.toMatch(
      /export \* from ["']\.\/autonomousMemory\.js["']/,
    );
  });

  it("keeps every package independent from root source", () => {
    const violations: string[] = [];
    for (const packageDirectory of listPackageDirectories()) {
      const sourceDirectory = path.join(packageDirectory, "src");
      for (const filePath of walkTypeScriptFiles(sourceDirectory)) {
        const source = fs.readFileSync(filePath, "utf8");
        if (/from\s+["'][^"']*(?:\/|^)src\//.test(source)) {
          violations.push(path.relative(ROOT, filePath));
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps legacy protocol files as pure package re-exports", () => {
    for (const shim of LEGACY_SHIMS) {
      const source = fs.readFileSync(path.join(ROOT, shim.path), "utf8");
      const exports = [`export * from "${shim.exportPath}";`];
      if (shim.additionalExport) exports.push(shim.additionalExport);
      expect(source).toBe(`${exports.join("\n")}\n`);
    }
  });

  it("keeps workspace-project DTO compatibility package-owned and test-only", () => {
    const compatibilitySource = fs.readFileSync(
      path.join(ROOT, "src/core/workspaceProjects.ts"),
      "utf8",
    );
    expect(compatibilitySource).toContain(
      'export * from "@agentlink/protocol/workspace-project";',
    );
    expect(compatibilitySource).toContain(
      "export interface ProjectScopeResolver",
    );
    expect(compatibilitySource).toContain(
      "export function createWorkspaceProjectId(",
    );

    const extractedTypePattern = new RegExp(
      `\\b(?:${[
        "NewSessionProjectSelectionInput",
        "NewSessionProjectSelectionResult",
        "NewSessionProjectSelectionSource",
        "ProjectAccessClassification",
        "ResolvedProjectResource",
        "SessionProjectResolution",
        "SessionProjectScope",
        "WorkspaceProject",
        "WorkspaceProjectAvailability",
        "WorkspaceProjectCatalogSnapshot",
        "WorkspaceProjectCatalogState",
        "createProjectlessSessionScope",
        "createSessionProjectScope",
        "isProjectlessSessionScope",
        "PROJECTLESS_SESSION_PROJECT_ID",
        "PROJECTLESS_SESSION_URI",
        "SESSION_PROJECT_SCOPE_SCHEMA_VERSION",
      ].join("|")})\\b`,
    );
    const importPattern =
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
    const dynamicImportPattern = /import\(["']([^"']+)["']\)\.([A-Za-z0-9_]+)/g;
    const importers: string[] = [];
    for (const filePath of walkTypeScriptFiles(path.join(ROOT, "src"))) {
      const relativePath = path.relative(ROOT, filePath);
      if (relativePath === "src/core/workspaceProjects.ts") continue;
      const source = fs.readFileSync(filePath, "utf8");
      const importsExtractedType = [...source.matchAll(importPattern)].some(
        (match) => {
          const specifier = match[2] ?? "";
          const importsCompatibilityPath =
            /(?:^|\/)core\/workspaceProjects(?:\.js)?$/.test(specifier) ||
            (path.dirname(relativePath) === "src/core" &&
              /^\.\/workspaceProjects(?:\.js)?$/.test(specifier));
          return (
            importsCompatibilityPath &&
            extractedTypePattern.test(match[1] ?? "")
          );
        },
      );
      const dynamicallyImportsExtractedType = [
        ...source.matchAll(dynamicImportPattern),
      ].some((match) => {
        const specifier = match[1] ?? "";
        const importsCompatibilityPath =
          /(?:^|\/)core\/workspaceProjects(?:\.js)?$/.test(specifier) ||
          (path.dirname(relativePath) === "src/core" &&
            /^\.\/workspaceProjects(?:\.js)?$/.test(specifier));
        return (
          importsCompatibilityPath && extractedTypePattern.test(match[2] ?? "")
        );
      });
      if (importsExtractedType || dynamicallyImportsExtractedType) {
        importers.push(relativePath);
      }
    }
    expect(importers).toEqual(["src/core/workspaceProjects.test.ts"]);
  });

  it("keeps chat-workspace compatibility package-owned and test-only", () => {
    const controllerCompatibilitySource = fs.readFileSync(
      path.join(ROOT, "src/agent/ChatTabController.ts"),
      "utf8",
    );
    expect(controllerCompatibilitySource).toContain(
      '} from "@agentlink/protocol/chat-workspace";',
    );
    expect(controllerCompatibilitySource).toContain(
      "export class ChatTabController",
    );

    const extractedTypePattern = new RegExp(
      `\\b(?:${[
        "CHAT_TAB_LAYOUT_VERSION",
        "ChatTab",
        "ChatTabActionAddress",
        "ChatTabActionConfirmationRequest",
        "ChatTabActionFailure",
        "ChatTabActionRejection",
        "ChatTabActionRejectionReason",
        "ChatTabDestructiveAction",
        "ChatTabLayout",
        "ChatTabPlacement",
        "ChatTabViewStatus",
        "ChatTabViewSummary",
        "ChatTabWorkspaceSnapshot",
        "ChatWorkspaceInteractiveExecutionPhase",
        "ChatWorkspaceSessionStatus",
        "ChatWorkspaceSessionSummary",
        "ChatWorkspaceViewSnapshot",
        "createChatWorkspaceViewSnapshot",
        "getChatTabViewStatus",
        "isChatTabSessionBusy",
        "parseChatTabActionAddress",
        "selectedWorkspaceSessionId",
      ].join("|")})\\b`,
    );
    const importPattern =
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
    const dynamicImportPattern = /import\(["']([^"']+)["']\)\.([A-Za-z0-9_]+)/g;
    const importers: string[] = [];
    for (const filePath of walkTypeScriptFiles(path.join(ROOT, "src"))) {
      const relativePath = path.relative(ROOT, filePath);
      if (relativePath === "src/agent/ChatTabController.ts") continue;
      const source = fs.readFileSync(filePath, "utf8");
      const isControllerCompatibilitySpecifier = (specifier: string): boolean =>
        /(?:^|\/)agent\/ChatTabController(?:\.js)?$/.test(specifier) ||
        (path.dirname(relativePath) === "src/agent" &&
          /^\.\/ChatTabController(?:\.js)?$/.test(specifier));
      const importsExtractedType = [...source.matchAll(importPattern)].some(
        (match) =>
          isControllerCompatibilitySpecifier(match[2] ?? "") &&
          extractedTypePattern.test(match[1] ?? ""),
      );
      const dynamicallyImportsExtractedType = [
        ...source.matchAll(dynamicImportPattern),
      ].some(
        (match) =>
          isControllerCompatibilitySpecifier(match[1] ?? "") &&
          extractedTypePattern.test(match[2] ?? ""),
      );
      if (importsExtractedType || dynamicallyImportsExtractedType) {
        importers.push(relativePath);
      }
    }
    expect(importers).toEqual(["src/agent/ChatTabController.test.ts"]);
  });

  it("keeps autonomous-memory compatibility package-owned and runtime-only", () => {
    const contractsSource = fs.readFileSync(
      path.join(ROOT, "src/core/memory/contracts.ts"),
      "utf8",
    );
    expect(contractsSource).toContain(
      'export * from "@agentlink/protocol/autonomous-memory";',
    );
    expect(contractsSource).toContain("export interface MemoryRepository");
    const capabilitySource = fs.readFileSync(
      path.join(ROOT, "src/core/capabilities/memory.ts"),
      "utf8",
    );
    expect(capabilitySource).toContain(
      '} from "@agentlink/protocol/autonomous-memory";',
    );
    expect(capabilitySource).toContain("export interface MemoryToolProvider");
    expect(capabilitySource).toContain(
      "export interface MemoryInspectionProvider",
    );

    const extractedTypePattern = new RegExp(
      `\\b(?:${[
        "AutomaticMemoryContext",
        "ClearMemoryScopeRequest",
        "ClearMemoryScopeResult",
        "ImportMemoryArchiveRequest",
        "ImportMemoryArchiveResult",
        "ImportMemoryRecordCandidate",
        "ImportMemoryRecordsRequest",
        "ImportMemoryRecordsResult",
        "ManageMemoryRequest",
        "ManageMemoryResult",
        "ManageMemoryToolInput",
        "ManageMemoryToolRequest",
        "MemoryActivityRequest",
        "MemoryArchiveV1",
        "MemoryAuditChange",
        "MemoryAuditEvent",
        "MemoryAuditOperation",
        "MemoryDisposition",
        "MemoryHealthSnapshot",
        "MemoryImportCheckpoint",
        "MemoryImportStatus",
        "MemoryInspectionDetailRequest",
        "MemoryInspectionDetailResult",
        "MemoryInspectionMutationContext",
        "MemoryInspectionQueryRequest",
        "MemoryKind",
        "MemoryLexicalCandidate",
        "MemoryLexicalSearchRequest",
        "MemoryManageOperation",
        "MemoryPanelSnapshot",
        "MemoryProvenance",
        "MemoryProvenanceSource",
        "MemoryRecord",
        "MemoryRecordDetail",
        "MemoryRevision",
        "MemoryScope",
        "MemoryStatus",
        "MemoryStoreSnapshot",
        "MemoryToolExecutionContext",
        "MemoryToolScope",
        "QueryMemoryRequest",
        "QueryMemoryResult",
        "RecalledMemory",
        "RecallMemoryRequest",
        "RecallMemoryResult",
        "RecallMemoryToolInput",
        "RecallMemoryToolRequest",
        "RecordMemoryImportFailureRequest",
      ].join("|")})\\b`,
    );
    const importPattern =
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
    const dynamicImportPattern = /import\(["']([^"']+)["']\)\.([A-Za-z0-9_]+)/g;
    const importers: string[] = [];
    for (const filePath of walkTypeScriptFiles(path.join(ROOT, "src"))) {
      const relativePath = path.relative(ROOT, filePath);
      if (
        relativePath === "src/core/memory/contracts.ts" ||
        relativePath === "src/core/capabilities/memory.ts"
      ) {
        continue;
      }
      const source = fs.readFileSync(filePath, "utf8");
      const isCompatibilitySpecifier = (specifier: string): boolean =>
        /(?:^|\/)(?:core\/memory\/contracts|core\/capabilities\/memory)(?:\.js)?$/.test(
          specifier,
        ) ||
        (path.dirname(relativePath) === "src/core/memory" &&
          /^\.\/contracts(?:\.js)?$/.test(specifier)) ||
        (path.dirname(relativePath) === "src/core/capabilities" &&
          /^\.\/memory(?:\.js)?$/.test(specifier));
      const importsExtractedType = [...source.matchAll(importPattern)].some(
        (match) =>
          isCompatibilitySpecifier(match[2] ?? "") &&
          extractedTypePattern.test(match[1] ?? ""),
      );
      const dynamicallyImportsExtractedType = [
        ...source.matchAll(dynamicImportPattern),
      ].some(
        (match) =>
          isCompatibilitySpecifier(match[1] ?? "") &&
          extractedTypePattern.test(match[2] ?? ""),
      );
      if (importsExtractedType || dynamicallyImportsExtractedType) {
        importers.push(relativePath);
      }
    }
    expect(importers).toEqual([
      "src/core/capabilities/memory.test.ts",
      "src/core/memory/contracts.test.ts",
    ]);
  });

  it("keeps chat-catalog compatibility package-owned and test-only", () => {
    const compatibilitySource = fs.readFileSync(
      path.join(ROOT, "src/agent/webview/types.ts"),
      "utf8",
    );
    for (const alias of [
      "export type ProjectInfo = ChatProjectInfo;",
      "export type ModeInfo = ChatModeInfo;",
      "export type ReasoningEffort = ChatReasoningEffort;",
      "export type WebviewModelInfo = ChatModelInfo;",
      "export type SlashCommandInfo = ChatSlashCommandInfo;",
    ]) {
      expect(compatibilitySource).toContain(alias);
    }

    const extractedTypePattern =
      /\b(?:ProjectInfo|ModeInfo|ReasoningEffort|WebviewModelInfo|SlashCommandInfo)\b/;
    const importPattern =
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
    const dynamicImportPattern = /import\(["']([^"']+)["']\)\.([A-Za-z0-9_]+)/g;
    const importers: string[] = [];
    for (const filePath of walkTypeScriptFiles(path.join(ROOT, "src"))) {
      const relativePath = path.relative(ROOT, filePath);
      if (relativePath === "src/agent/webview/types.ts") continue;
      const source = fs.readFileSync(filePath, "utf8");
      const isCompatibilitySpecifier = (specifier: string): boolean => {
        if (!specifier.startsWith(".")) {
          return /(?:^|\/)agent\/webview\/types(?:\.js)?$/.test(specifier);
        }
        const resolved = path.resolve(path.dirname(filePath), specifier);
        const withoutExtension = resolved.replace(/\.js$/, "");
        return withoutExtension === path.join(ROOT, "src/agent/webview/types");
      };
      const importsExtractedType = [...source.matchAll(importPattern)].some(
        (match) =>
          isCompatibilitySpecifier(match[2] ?? "") &&
          extractedTypePattern.test(match[1] ?? ""),
      );
      const dynamicallyImportsExtractedType = [
        ...source.matchAll(dynamicImportPattern),
      ].some(
        (match) =>
          isCompatibilitySpecifier(match[1] ?? "") &&
          extractedTypePattern.test(match[2] ?? ""),
      );
      if (importsExtractedType || dynamicallyImportsExtractedType) {
        importers.push(relativePath);
      }
    }
    expect(importers).toEqual(["src/agent/webview/types.test.ts"]);
  });

  it("keeps session-handoff-draft compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(ROOT, "src/agent/sessionHandoff.ts");
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    expect(compatibilitySource).toMatch(
      /export\s*\{\s*SESSION_HANDOFF_SCHEMA_VERSION,\s*type SessionHandoffDraft,\s*type SessionHandoffSections,?\s*\}\s*from\s*["']@agentlink\/protocol\/session-handoff-draft["'];/,
    );
    expect(compatibilitySource).toContain(
      "export function buildSessionHandoffSourcePack(",
    );
    expect(compatibilitySource).toContain(
      "export interface PersistedSessionLineage",
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+(?:interface|type)\s+(?:SessionHandoffDraft|SessionHandoffSections)\b/,
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+const\s+SESSION_HANDOFF_SCHEMA_VERSION\s*=/,
    );

    const importers: string[] = [];
    const staticImportOrExportPattern =
      /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
    const dynamicImportPattern = /import\(["']([^"']+)["']\)\.([A-Za-z0-9_]+)/g;
    const namespaceImportPattern =
      /import\s+\*\s+as\s+[A-Za-z0-9_]+\s+from\s+["']([^"']+)["']/g;
    const bareExportPattern = /export\s+\*\s+from\s+["']([^"']+)["']/g;
    const extractedTypePattern =
      /\b(?:SESSION_HANDOFF_SCHEMA_VERSION|SessionHandoffDraft|SessionHandoffSections)\b/;
    for (const filePath of walkTypeScriptFiles(path.join(ROOT, "src"))) {
      if (filePath === compatibilityPath) continue;
      const relativePath = path.relative(ROOT, filePath);
      const source = fs.readFileSync(filePath, "utf8");
      const isCompatibilitySpecifier = (specifier: string): boolean =>
        /(?:^|\/)agent\/sessionHandoff(?:\.js)?$/.test(specifier) ||
        (path.dirname(relativePath) === "src/agent" &&
          /^\.\/sessionHandoff(?:\.js)?$/.test(specifier)) ||
        (path.dirname(relativePath) === "src/agent/webview" &&
          /^\.\.\/sessionHandoff(?:\.js)?$/.test(specifier)) ||
        (path.dirname(relativePath) === "src/browser-gateway/webview" &&
          /^\.\.\/\.\.\/agent\/sessionHandoff(?:\.js)?$/.test(specifier));
      const staticallyImportsOrExportsExtractedType = [
        ...source.matchAll(staticImportOrExportPattern),
      ].some(
        (match) =>
          isCompatibilitySpecifier(match[2] ?? "") &&
          extractedTypePattern.test(match[1] ?? ""),
      );
      const dynamicallyImportsExtractedType = [
        ...source.matchAll(dynamicImportPattern),
      ].some(
        (match) =>
          isCompatibilitySpecifier(match[1] ?? "") &&
          extractedTypePattern.test(match[2] ?? ""),
      );
      const namespaceImportsCompatibilityModule = [
        ...source.matchAll(namespaceImportPattern),
      ].some((match) => isCompatibilitySpecifier(match[1] ?? ""));
      const reexportsCompatibilityModule = [
        ...source.matchAll(bareExportPattern),
      ].some((match) => isCompatibilitySpecifier(match[1] ?? ""));
      if (
        staticallyImportsOrExportsExtractedType ||
        dynamicallyImportsExtractedType ||
        namespaceImportsCompatibilityModule ||
        reexportsCompatibilityModule
      ) {
        importers.push(relativePath);
      }
    }
    const dirtyImporterBaseline = new Set([
      "src/agent/AgentSessionManager.ts",
      "src/agent/ChatViewProvider.ts",
      "src/agent/webview/App.tsx",
      "src/agent/webview/types.ts",
      "src/browser-gateway/webview/BrowserGatewayApp.tsx",
    ]);
    expect(
      importers.every((importer) => dirtyImporterBaseline.has(importer)),
    ).toBe(true);
  });

  it("keeps diff-snapshot compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/DiffSnapshotHub.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    expect(compatibilitySource).toContain(
      '} from "@agentlink/protocol/diff-snapshot";',
    );
    expect(compatibilitySource).toContain("export const diffSnapshotHub");
    expect(compatibilitySource).not.toMatch(
      /export\s+(?:interface|type)\s+DiffSnapshot(?:Preview)?\b/,
    );

    const importers: string[] = [];
    const staticImportOrExportPattern =
      /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
    const dynamicImportPattern = /import\(["']([^"']+)["']\)\.([A-Za-z0-9_]+)/g;
    const extractedTypePattern = /\b(?:DiffSnapshot|DiffSnapshotPreview)\b/;
    for (const filePath of walkTypeScriptFiles(path.join(ROOT, "src"))) {
      if (filePath === compatibilityPath) continue;
      const relativePath = path.relative(ROOT, filePath);
      const source = fs.readFileSync(filePath, "utf8");
      const isCompatibilitySpecifier = (specifier: string): boolean =>
        /(?:^|\/)browser-gateway\/DiffSnapshotHub(?:\.js)?$/.test(specifier) ||
        (path.dirname(relativePath) === "src/browser-gateway" &&
          /^\.\/DiffSnapshotHub(?:\.js)?$/.test(specifier));
      const staticallyImportsOrExportsExtractedType = [
        ...source.matchAll(staticImportOrExportPattern),
      ].some(
        (match) =>
          isCompatibilitySpecifier(match[2] ?? "") &&
          extractedTypePattern.test(match[1] ?? ""),
      );
      const dynamicallyImportsExtractedType = [
        ...source.matchAll(dynamicImportPattern),
      ].some(
        (match) =>
          isCompatibilitySpecifier(match[1] ?? "") &&
          extractedTypePattern.test(match[2] ?? ""),
      );
      if (
        staticallyImportsOrExportsExtractedType ||
        dynamicallyImportsExtractedType
      ) {
        importers.push(relativePath);
      }
    }
    // Dirty-file baseline: this importer may disappear without changing the guard.
    expect(
      importers.every(
        (importer) =>
          importer === "src/browser-gateway/BrowserGatewayService.ts",
      ),
    ).toBe(true);
    expect(importers.length).toBeLessThanOrEqual(1);

    const browserSource = fs.readFileSync(
      path.join(ROOT, "src/browser-gateway/webview/BrowserGatewayApp.tsx"),
      "utf8",
    );
    expect(browserSource).toContain(
      [
        "  diffs: Array<{",
        "    requestId: string;",
        "    filePath: string;",
        "    operation: string;",
        "    originalPreview: string;",
        "    proposedPreview: string;",
        "    outsideWorkspace: boolean;",
        "    createdAt: number;",
        "  }>;",
      ].join("\n"),
    );
  });

  it("keeps chat-pane transport compatibility package-owned with bounded importers", () => {
    const protocolCompatibilityPath = path.join(
      ROOT,
      "src/agent/chatPaneProtocol.ts",
    );
    const protocolCompatibilitySource = fs.readFileSync(
      protocolCompatibilityPath,
      "utf8",
    );
    expect(protocolCompatibilitySource).toContain(
      '} from "@agentlink/protocol/chat-pane-transport";',
    );
    expect(protocolCompatibilitySource).toContain(
      "export const CHAT_PANEL_VIEW_TYPE",
    );
    expect(protocolCompatibilitySource).toContain(
      "export function parseSerializedChatPanelState(",
    );
    expect(protocolCompatibilitySource).not.toMatch(
      /export interface ChatPaneAddress/,
    );

    const authorityCompatibilityPath = path.join(
      ROOT,
      "src/agent/ChatPaneAuthorityController.ts",
    );
    const authorityCompatibilitySource = fs.readFileSync(
      authorityCompatibilityPath,
      "utf8",
    );
    expect(authorityCompatibilitySource).toContain(
      '} from "@agentlink/protocol/chat-pane-transport";',
    );
    expect(authorityCompatibilitySource).toContain(
      "export class ChatPaneAuthorityController",
    );
    expect(authorityCompatibilitySource).not.toMatch(
      /export (?:interface ChatPaneLease|type ChatPaneSurface)/,
    );

    const protocolTypePattern =
      /\b(?:ChatPaneAddress|ChatPaneAddressedMessage|ChatWebviewBootstrap|addressChatPaneMessage|createChatPaneAddress|parseChatPaneAddress|parseChatPaneMessageAddress|parseChatWebviewBootstrap|sameChatPaneAddress)\b/;
    const authorityTypePattern = /\b(?:ChatPaneLease|ChatPaneSurface)\b/;
    const importPattern =
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
    const protocolImporters: string[] = [];
    const authorityImporters: string[] = [];
    for (const filePath of walkTypeScriptFiles(path.join(ROOT, "src"))) {
      if (
        filePath === protocolCompatibilityPath ||
        filePath === authorityCompatibilityPath
      ) {
        continue;
      }
      const relativePath = path.relative(ROOT, filePath);
      const source = fs.readFileSync(filePath, "utf8");
      const imports = [...source.matchAll(importPattern)];
      const importsProtocolType = imports.some((match) => {
        const importedNames = match[1] ?? "";
        const specifier = match[2] ?? "";
        const protocolCompatibilityImport =
          /(?:^|\/)agent\/chatPaneProtocol(?:\.js)?$/.test(specifier) ||
          (path.dirname(relativePath) === "src/agent" &&
            /^\.\/chatPaneProtocol(?:\.js)?$/.test(specifier)) ||
          (path.dirname(relativePath) === "src/agent/webview" &&
            /^\.\.\/chatPaneProtocol(?:\.js)?$/.test(specifier));
        return (
          protocolCompatibilityImport && protocolTypePattern.test(importedNames)
        );
      });
      const importsAuthorityType = imports.some((match) => {
        const importedNames = match[1] ?? "";
        const specifier = match[2] ?? "";
        const authorityCompatibilityImport =
          /(?:^|\/)agent\/ChatPaneAuthorityController(?:\.js)?$/.test(
            specifier,
          ) ||
          (path.dirname(relativePath) === "src/agent" &&
            /^\.\/ChatPaneAuthorityController(?:\.js)?$/.test(specifier));
        return (
          authorityCompatibilityImport &&
          authorityTypePattern.test(importedNames)
        );
      });
      if (importsProtocolType) protocolImporters.push(relativePath);
      if (importsAuthorityType) authorityImporters.push(relativePath);
    }
    expect(protocolImporters).toEqual([
      "src/agent/chatPaneProtocol.test.ts",
      "src/agent/webview/App.tsx",
      "src/agent/webview/chatTabActions.ts",
    ]);
    expect(authorityImporters).toEqual(["src/agent/ChatViewProvider.ts"]);
  });

  it("keeps find-replace-preview compatibility package-owned and unused", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/findReplace/webview/types.ts",
    );
    expect(fs.readFileSync(compatibilityPath, "utf8")).toBe(
      [
        "export type {",
        "  FindReplaceFileGroup,",
        "  FindReplaceMatch,",
        "  FindReplacePreviewData,",
        "  PreviewExtensionMessage,",
        "  PreviewWebviewMessage,",
        '} from "@agentlink/protocol/find-replace-preview";',
        "",
      ].join("\n"),
    );

    const importers: string[] = [];
    const compatibilityModule = compatibilityPath.replace(/\.ts$/, "");
    const importPattern = /from\s+["']([^"']+)["']/g;
    for (const filePath of walkTypeScriptFiles(path.join(ROOT, "src"))) {
      if (filePath === compatibilityPath) continue;
      const source = fs.readFileSync(filePath, "utf8");
      const importsCompatibilityPath = [...source.matchAll(importPattern)].some(
        (match) => {
          const specifier = match[1] ?? "";
          if (!specifier.startsWith(".")) {
            return /(?:^|\/)findReplace\/webview\/types(?:\.js)?$/.test(
              specifier,
            );
          }
          const resolved = path.resolve(path.dirname(filePath), specifier);
          return resolved.replace(/\.js$/, "") === compatibilityModule;
        },
      );
      if (importsCompatibilityPath)
        importers.push(path.relative(ROOT, filePath));
    }
    expect(importers).toEqual([]);
  });

  it("keeps approval-transport compatibility package-owned and unused", () => {
    const compatibilityPath = path.join(ROOT, "src/approvals/webview/types.ts");
    expect(fs.readFileSync(compatibilityPath, "utf8")).toBe(
      [
        "export type {",
        "  ApprovalKind,",
        "  ApprovalProjectContext,",
        "  ApprovalRequest,",
        "  CommandRecoveryAttempt,",
        "  CommandReviewSummary,",
        "  CommandTierLevel,",
        "  DecisionMessage,",
        "  ExtensionMessage,",
        "  InlineCommandFilePreview,",
        "  MemoryOperation,",
        "  MemoryScope,",
        "  MemoryTier,",
        "  NetworkReviewSummary,",
        "  RuleEntry,",
        "  SubCommandEntry,",
        "  SuggestRegexMessage,",
        '} from "@agentlink/protocol/approval-transport";',
        "",
      ].join("\n"),
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    expect(
      findCompatibilityImporters({ compatibilityPath, sourceFiles }),
    ).toEqual([]);
  });

  it("keeps web-access-policy compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(ROOT, "src/core/webAccess.ts");
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const packageSource = fs.readFileSync(
      path.join(ROOT, "packages/core/src/webAccess.ts"),
      "utf8",
    );
    expect(compatibilitySource).toBe(
      'export * from "@agentlink/core/web-access";\n',
    );
    const extractedNames = [
      "CoreHostedToolDefinition",
      "CoreHostedWebCapabilities",
      "CoreHostedWebFetchDefinition",
      "CoreHostedWebSearchDefinition",
      "CoreHostedWebToolCapability",
      "CoreResolveWebAccessPolicyInput",
      "CoreResolvedWebAccessPolicy",
      "CoreResolvedWebAccessRoute",
      "CoreWebAccessResolutionReason",
      "CoreWebAccessSelection",
      "CoreWebAccessSettings",
      "CoreWebAccessSettingsInput",
      "CoreWebSearchMode",
    ] as const;

    expect(packageSource).toContain(
      [
        "export type {",
        ...extractedNames.map((name) => `  ${name},`),
        '} from "@agentlink/protocol/web-access-policy";',
      ].join("\n"),
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const dirtyImporterBaseline = new Set([
      "src/agent/AgentSessionManager.ts",
      "src/agent/ChatViewProvider.ts",
      "src/browser-gateway/helper/browserGatewayHelper.ts",
    ]);
    expect(
      importers.every((importer) => dirtyImporterBaseline.has(importer)),
    ).toBe(true);
    expect(importers.length).toBeLessThanOrEqual(dirtyImporterBaseline.size);
  });

  it("keeps web-activity compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(ROOT, "src/core/webAccess.ts");
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const packageSource = fs.readFileSync(
      path.join(ROOT, "packages/core/src/webAccess.ts"),
      "utf8",
    );
    expect(compatibilitySource).toBe(
      'export * from "@agentlink/core/web-access";\n',
    );
    const extractedNames = [
      "CoreWebAccessBackend",
      "CoreWebActivity",
      "CoreWebActivityStatus",
      "CoreWebCitation",
      "CoreWebToolKind",
    ] as const;

    expect(packageSource).toContain(
      '} from "@agentlink/protocol/web-activity";',
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const dirtyImporterBaseline = new Set([
      "src/agent/toolAdapter.ts",
      "src/browser-gateway/helper/browserGatewayHelper.ts",
      "src/core/tools/types.ts",
      "src/shared/chatProjection.ts",
    ]);
    expect(
      importers.every((importer) => dirtyImporterBaseline.has(importer)),
    ).toBe(true);
    expect(importers.length).toBeLessThanOrEqual(dirtyImporterBaseline.size);
  });

  it("keeps provider-replay compatibility package-owned and unused", () => {
    const compatibilityPath = path.join(ROOT, "src/core/webAccess.ts");
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const packageSource = fs.readFileSync(
      path.join(ROOT, "packages/core/src/webAccess.ts"),
      "utf8",
    );
    expect(compatibilitySource).toBe(
      'export * from "@agentlink/core/web-access";\n',
    );
    const extractedNames = [
      "CoreJsonValue",
      "CoreProviderReplayEnvelope",
    ] as const;

    expect(packageSource).toContain(
      [
        "export type {",
        ...extractedNames.map((name) => `  ${name},`),
        '} from "@agentlink/protocol/provider-replay";',
      ].join("\n"),
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    expect(
      findCompatibilityImporters({
        compatibilityPath,
        sourceFiles,
        extractedNames,
      }),
    ).toEqual([]);
  });

  it("keeps retrieval-deletion compatibility package-owned and unused", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/core/retrieval/contracts.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "RetrievalDeleteScopeOutcome",
      "RetrievalDeleteScopeRequest",
      "RetrievalDeleteSourceOutcome",
      "RetrievalDeleteSourceRequest",
    ] as const;

    expect(compatibilitySource).toContain(
      '} from "@agentlink/protocol/retrieval-deletion";',
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    expect(
      findCompatibilityImporters({
        compatibilityPath,
        sourceFiles,
        extractedNames,
      }),
    ).toEqual([]);
  });

  it("keeps retrieval-fingerprint compatibility package-owned and unused", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/core/retrieval/contracts.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "RetrievalEmbeddingFingerprint",
      "RetrievalFingerprint",
      "RetrievalFingerprintDisposition",
    ] as const;

    expect(compatibilitySource).toContain(
      '} from "@agentlink/protocol/retrieval-fingerprint";',
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    expect(
      findCompatibilityImporters({
        compatibilityPath,
        sourceFiles,
        extractedNames,
      }),
    ).toEqual([]);
  });

  it("keeps retrieval-publication compatibility package-owned and unused", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/core/retrieval/contracts.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "RetrievalAbortPublicationOutcome",
      "RetrievalPublicationBatchOutcome",
      "RetrievalPublicationOutcome",
      "RetrievalPublicationPreparation",
      "RetrievalPublicationRequest",
      "RetrievalStagedChunkBatch",
      "RetrievalStagedPublicationBundle",
      "RetrievalStagedPublicationInspection",
      "RetrievalStagedPublicationManifest",
      "RetrievalStagedRelationBatch",
    ] as const;

    expect(compatibilitySource).toContain(
      '} from "@agentlink/protocol/retrieval-publication";',
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    expect(
      findCompatibilityImporters({
        compatibilityPath,
        sourceFiles,
        extractedNames,
      }),
    ).toEqual([]);
  });

  it("keeps retrieval-query compatibility package-owned and unused", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/core/retrieval/contracts.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "RetrievalCandidateScores",
      "RetrievalDiversityPolicy",
      "RetrievalQuery",
      "RetrievalQueryCandidate",
      "RetrievalQueryFilter",
      "RetrievalQueryFreshnessSummary",
      "RetrievalQueryResult",
      "RetrievalRankingInput",
      "RetrievalSourceFreshness",
      "RetrievalStaleSource",
    ] as const;

    expect(compatibilitySource).toContain(
      '} from "@agentlink/protocol/retrieval-query";',
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    expect(
      findCompatibilityImporters({
        compatibilityPath,
        sourceFiles,
        extractedNames,
      }),
    ).toEqual([]);
  });

  it("keeps retrieval-records compatibility package-owned and unused", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/core/retrieval/contracts.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "RetrievalChunkLocation",
      "RetrievalChunkRecord",
      "RetrievalNamespace",
      "RetrievalRelationRecord",
      "RetrievalSourceDocument",
      "RetrievalSourceKind",
      "RetrievalSourceRevision",
    ] as const;

    expect(compatibilitySource).toContain(
      '} from "@agentlink/protocol/retrieval-records";',
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    expect(
      findCompatibilityImporters({
        compatibilityPath,
        sourceFiles,
        extractedNames,
      }),
    ).toEqual([]);
  });

  it("keeps retrieval-maintenance compatibility package-owned and unused", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/core/retrieval/contracts.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "RetrievalAggregateMetrics",
      "RetrievalMigrationOutcome",
      "RetrievalOptimizeOutcome",
      "RetrievalRepairOutcome",
      "RetrievalSnapshot",
      "RetrievalSnapshotOutcome",
    ] as const;

    expect(compatibilitySource).toContain(
      '} from "@agentlink/protocol/retrieval-maintenance";',
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    expect(
      findCompatibilityImporters({
        compatibilityPath,
        sourceFiles,
        extractedNames,
      }),
    ).toEqual([]);
  });

  it("keeps retrieval-structural-snapshot compatibility package-owned and unused", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/core/retrieval/contracts.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "RetrievalActiveSource",
      "RetrievalStructuralSnapshot",
      "RetrievalStructuralSnapshotRequest",
    ] as const;

    expect(compatibilitySource).toContain(
      '} from "@agentlink/protocol/retrieval-structural-snapshot";',
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    expect(
      findCompatibilityImporters({
        compatibilityPath,
        sourceFiles,
        extractedNames,
      }),
    ).toEqual([]);
  });

  it("keeps retrieval-health compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/core/retrieval/contracts.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "RetrievalHealthReason",
      "RetrievalHealthSnapshot",
      "RetrievalLexicalReadiness",
    ] as const;

    expect(compatibilitySource).toContain(
      '} from "@agentlink/protocol/retrieval-health";',
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const dirtyImporterBaseline = new Set(["src/agent/ChatViewProvider.ts"]);
    expect(
      importers.every((importer) => dirtyImporterBaseline.has(importer)),
    ).toBe(true);
    expect(importers.length).toBeLessThanOrEqual(dirtyImporterBaseline.size);
  });

  it("keeps sidebar-transport compatibility package-owned and unused", () => {
    const compatibilityPath = path.join(ROOT, "src/sidebar/webview/types.ts");
    expect(fs.readFileSync(compatibilityPath, "utf8")).toBe(
      [
        "export type {",
        "  CommandRule,",
        "  ExtensionMessage,",
        "  FeedbackEntry,",
        "  FeedbackPriority,",
        "  IndexStatusInfo,",
        "  PathRule,",
        "  PostCommand,",
        "  RuleEditCommand,",
        "  RuleRemoveCommand,",
        "  SessionInfo,",
        "  SidebarState,",
        "  TrackedCallInfo,",
        "  WebviewCommand,",
        "  WriteApprovalMode,",
        '} from "@agentlink/protocol/sidebar-transport";',
        "",
      ].join("\n"),
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    expect(
      findCompatibilityImporters({ compatibilityPath, sourceFiles }),
    ).toEqual([]);
  });

  it("keeps browser Ask Agent identity compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/browserGatewayAskAgentIdentity.ts",
    );
    expect(fs.readFileSync(compatibilityPath, "utf8")).toBe(
      'export * from "@agentlink/protocol/browser-gateway-ask-agent-identity";\n',
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/browserGatewayAskAgentSessionStore.ts",
      "src/browser-gateway/helper/browserGatewayHelper.ts",
      "src/browser-gateway/webview/BrowserGatewayApp.test.ts",
      "src/browser-gateway/webview/BrowserGatewayApp.tsx",
      "src/browser-gateway/webview/relay/relayClientSelection.test.ts",
      "src/browser-gateway/webview/relay/useRelayGatewayConnection.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway core-owner registration compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/coreOwnerRegistry.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "BrowserGatewayCoreOwnerHeartbeat",
      "BrowserGatewayCoreOwnerRegistration",
      "BrowserGatewayCoreOwnerRegistrationResolution",
      "BrowserGatewayCoreOwnerRegistrationResult",
      "BrowserGatewayCoreOwnerStatus",
    ] as const;
    expect(compatibilitySource).toContain(
      '} from "@agentlink/protocol/browser-gateway-core-owner-registration";',
    );
    expect(compatibilitySource).toContain(
      "export class BrowserGatewayCoreOwnerRegistry",
    );
    expect(compatibilitySource).toContain(
      "export interface BrowserGatewayCoreOwnerRegistryOptions",
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/OwnerTransport.ts",
      "src/browser-gateway/protocol.ts",
      "src/browser-gateway/testing/GatewayGenerationFaultHarness.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway helper lifecycle compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "BROWSER_GATEWAY_DATA_PLANE_FEATURES",
      "BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION",
      "BrowserGatewayDataPlaneFeature",
      "BrowserGatewayHelperDiscoveryRecord",
      "BrowserGatewayHelperHealthResponse",
    ] as const;
    expect(compatibilitySource).toContain(
      [
        "export {",
        "  BROWSER_GATEWAY_DATA_PLANE_FEATURES,",
        "  BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,",
        '} from "@agentlink/protocol/browser-gateway-helper-lifecycle";',
      ].join("\n"),
    );
    expect(compatibilitySource).toContain(
      [
        "export type {",
        "  BrowserGatewayDataPlaneFeature,",
        "  BrowserGatewayHelperDiscoveryRecord,",
        "  BrowserGatewayHelperHealthResponse,",
        '} from "@agentlink/protocol/browser-gateway-helper-lifecycle";',
      ].join("\n"),
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type|const)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/browserGatewayCommands.test.ts",
      "src/browser-gateway/browserGatewayCommands.ts",
      "src/browser-gateway/browserGatewayHelperDiscovery.test.ts",
      "src/browser-gateway/browserGatewayHelperDiscovery.ts",
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/dataPlane/OwnerTransport.ts",
      "src/browser-gateway/helper/bootstrapHelper.test.ts",
      "src/browser-gateway/helper/bootstrapHelper.ts",
      "src/browser-gateway/helper/browserGatewayGenerationFaults.test.ts",
      "src/browser-gateway/helper/browserGatewayHelper.lifecycle.integration.test.ts",
      "src/browser-gateway/helper/browserGatewayHelper.ts",
      "src/extension.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway capability-status compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayCapabilityStatus"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayCapabilityStatus } from "@agentlink/protocol/browser-gateway-capability-status";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+interface\s+BrowserGatewayCapabilityStatus\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway relay theme-state compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "BrowserGatewayThemeState",
      "BrowserGatewayThemeVariable",
    ] as const;
    expect(compatibilitySource).toContain(
      [
        "export type {",
        "  BrowserGatewayThemeState,",
        "  BrowserGatewayThemeVariable,",
        '} from "@agentlink/protocol/browser-gateway-theme";',
      ].join("\n"),
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(`export\\s+interface\\s+${extractedName}\\b`),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/testing/stateEquivalenceOracle.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway background-summary compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayBackgroundSummary"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayBackgroundSummary } from "@agentlink/protocol/browser-gateway-background-summary";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+interface\s+BrowserGatewayBackgroundSummary\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/webview/relay/relaySnapshotProjection.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway transcript-window compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayTranscriptWindow"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayTranscriptWindow } from "@agentlink/protocol/browser-gateway-transcript-window";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+interface\s+BrowserGatewayTranscriptWindow\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/testing/stateEquivalenceOracle.ts",
      "src/browser-gateway/webview/relay/RelayOwnerStore.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway transcript-message compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayTranscriptMessage"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayTranscriptMessage } from "@agentlink/protocol/browser-gateway-transcript-message";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+interface\s+BrowserGatewayTranscriptMessage\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/OwnerTransport.ts",
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/testing/phase3LiveParityGate.ts",
      "src/browser-gateway/testing/phase3ReliabilityGate.ts",
      "src/browser-gateway/testing/stateEquivalenceOracle.ts",
      "src/browser-gateway/webview/relay/RelayOwnerStore.ts",
      "src/browser-gateway/webview/relay/relaySnapshotProjection.test.ts",
      "src/browser-gateway/webview/relay/relaySnapshotProjection.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway transcript-block compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayTranscriptBlock"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayTranscriptBlock } from "@agentlink/protocol/browser-gateway-transcript-block";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+type\s+BrowserGatewayTranscriptBlock\b\s*=/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway transcript-text compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayTranscriptText"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayTranscriptText } from "@agentlink/protocol/browser-gateway-transcript-text";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+type\s+BrowserGatewayTranscriptText\b\s*=/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/testing/stateEquivalenceOracle.ts",
      "src/browser-gateway/webview/relay/relaySnapshotProjection.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway detached-session selection compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/BrowserGatewayService.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayDetachedSessionSelection"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayDetachedSessionSelection } from "@agentlink/protocol/browser-gateway-detached-session-selection";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+(?:interface|type)\s+BrowserGatewayDetachedSessionSelection\b(?:\s*=)?/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerCommandExecutor.ts",
      "src/browser-gateway/webview/sessionDetailTransport.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway diff-preview compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayDiffPreview"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayDiffPreview } from "@agentlink/protocol/browser-gateway-diff-preview";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+interface\s+BrowserGatewayDiffPreview\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway interaction-state compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayInteractionState"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayInteractionState } from "@agentlink/protocol/browser-gateway-interaction-state";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+interface\s+BrowserGatewayInteractionState\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway interaction-summary compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayInteractionSummary"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayInteractionSummary } from "@agentlink/protocol/browser-gateway-interaction-summary";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+interface\s+BrowserGatewayInteractionSummary\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/testing/stateEquivalenceOracle.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway owner-control metadata compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "BROWSER_GATEWAY_OWNER_CONTROL_KINDS",
      "BROWSER_GATEWAY_RELAY_RESET_REASONS",
      "BrowserGatewayOwnerControlKind",
      "BrowserGatewayRelayResetReason",
    ] as const;
    expect(compatibilitySource).toContain(
      'from "@agentlink/protocol/browser-gateway-owner-control-metadata";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+const\s+BROWSER_GATEWAY_OWNER_CONTROL_KINDS\b/,
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+type\s+BrowserGateway(?:OwnerControlKind|RelayResetReason)\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/protocol.test.ts",
      "src/browser-gateway/helper/OwnerRelayStore.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway owner-event metadata compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "BROWSER_GATEWAY_OWNER_EVENT_KINDS",
      "BrowserGatewayOwnerEventKind",
    ] as const;
    expect(compatibilitySource).toContain(
      'from "@agentlink/protocol/browser-gateway-owner-event-metadata";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+const\s+BROWSER_GATEWAY_OWNER_EVENT_KINDS\b/,
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+type\s+BrowserGatewayOwnerEventKind\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/OwnerTransport.ts",
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/dataPlane/protocol.test.ts",
      "src/browser-gateway/testing/ownerDataPlaneLoadFixture.ts",
      "src/browser-gateway/testing/phase3MobileBrowserFixture.ts",
      "src/browser-gateway/webview/relay/useRelayGatewayConnection.test.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway operation-state compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "BROWSER_GATEWAY_OPERATION_STATUSES",
      "BrowserGatewayOperationState",
      "BrowserGatewayOperationStatus",
    ] as const;
    expect(compatibilitySource).toContain("type BrowserGatewayOperationState,");
    expect(compatibilitySource).toContain(
      'from "@agentlink/protocol/browser-gateway-operation-state";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+interface\s+BrowserGatewayOperationState\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.ts",
      "src/browser-gateway/helper/AskAgentOwnerAdapter.ts",
      "src/browser-gateway/helper/commandRoutes.test.ts",
      "src/browser-gateway/helper/commandRoutes.ts",
      "src/browser-gateway/helper/relayRoutes.ts",
      "src/browser-gateway/testing/stateEquivalenceOracle.ts",
      "src/browser-gateway/webview/relay/RelayConnectionManager.ts",
      "src/browser-gateway/webview/relay/RelayOwnerStore.ts",
      "src/browser-gateway/webview/relay/useRelayGatewayConnection.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway command-metadata compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "BROWSER_GATEWAY_COMMAND_DEADLINE_CLASSES",
      "BROWSER_GATEWAY_COMMAND_IDEMPOTENCIES",
      "BROWSER_GATEWAY_COMMAND_IDEMPOTENCY",
      "BROWSER_GATEWAY_OWNER_COMMAND_KINDS",
      "BrowserGatewayCommandDeadlineClass",
      "BrowserGatewayCommandIdempotency",
      "BrowserGatewayOwnerCommandKind",
    ] as const;
    expect(compatibilitySource).toContain(
      'from "@agentlink/protocol/browser-gateway-owner-command-metadata";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+const\s+BROWSER_GATEWAY_OWNER_COMMAND_KINDS\b/,
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+const\s+BROWSER_GATEWAY_COMMAND_(?:DEADLINE_CLASSES|IDEMPOTENCIES|IDEMPOTENCY)\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerCommandExecutor.ts",
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.test.ts",
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.ts",
      "src/browser-gateway/dataPlane/OwnerTransport.test.ts",
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/helper/AskAgentOwnerAdapter.test.ts",
      "src/browser-gateway/helper/AskAgentOwnerAdapter.ts",
      "src/browser-gateway/helper/commandRoutes.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.test.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.unit.test.ts",
      "src/browser-gateway/migration/actionSurfaceInventory.test.ts",
      "src/browser-gateway/migration/actionSurfaceInventory.ts",
      "src/browser-gateway/webview/relay/RelayConnectionManager.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway todo-item compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayTodoItem"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayTodoItem } from "@agentlink/protocol/browser-gateway-todo-item";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+interface\s+BrowserGatewayTodoItem\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/testing/stateEquivalenceOracle.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway queue-item compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayQueueItem"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayQueueItem } from "@agentlink/protocol/browser-gateway-queue-item";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+interface\s+BrowserGatewayQueueItem\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/testing/stateEquivalenceOracle.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway repository-state compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayRepositoryState"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayRepositoryState } from "@agentlink/protocol/browser-gateway-repository-state";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+interface\s+BrowserGatewayRepositoryState\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway context-budget compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayContextBudget"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayContextBudget } from "@agentlink/protocol/browser-gateway-context-budget";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+interface\s+BrowserGatewayContextBudget\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/testing/stateEquivalenceOracle.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway protocol-error compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "BrowserGatewayProtocolError",
      "BrowserGatewayProtocolErrorCode",
    ] as const;
    expect(compatibilitySource).toContain(
      'from "@agentlink/protocol/browser-gateway-protocol-error";',
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:class|interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.test.ts",
      "src/browser-gateway/dataPlane/protocol.test.ts",
      "src/browser-gateway/helper/commandRoutes.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway owner-publication batch compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayOwnerPublicationBatch"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayOwnerPublicationBatch } from "@agentlink/protocol/browser-gateway-owner-publication-batch";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+(?:interface|type)\s+BrowserGatewayOwnerPublicationBatch\b(?:\s*=)?/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/OwnerTransport.test.ts",
      "src/browser-gateway/dataPlane/OwnerTransport.ts",
      "src/browser-gateway/helper/AskAgentOwnerAdapter.test.ts",
      "src/browser-gateway/helper/AskAgentOwnerAdapter.ts",
      "src/browser-gateway/helper/OwnerRelayStore.test.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.test.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.unit.test.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway owner-checkpoint compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayOwnerCheckpoint"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayOwnerCheckpoint } from "@agentlink/protocol/browser-gateway-owner-checkpoint";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+(?:interface|type)\s+BrowserGatewayOwnerCheckpoint\b(?:\s*=)?/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/OwnerTransport.test.ts",
      "src/browser-gateway/dataPlane/OwnerTransport.ts",
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/helper/AskAgentOwnerAdapter.ts",
      "src/browser-gateway/helper/OwnerRelayStore.test.ts",
      "src/browser-gateway/helper/OwnerRelayStore.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.test.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.unit.test.ts",
      "src/browser-gateway/helper/relayRoutes.test.ts",
      "src/browser-gateway/testing/ownerDataPlaneLoadFixture.ts",
      "src/browser-gateway/testing/phase3LiveParityGate.ts",
      "src/browser-gateway/testing/phase3ReliabilityGate.ts",
      "src/browser-gateway/testing/stateEquivalenceOracle.ts",
      "src/browser-gateway/webview/relay/RelayConnectionManager.test.ts",
      "src/browser-gateway/webview/relay/RelayOwnerStore.test.ts",
      "src/browser-gateway/webview/relay/RelayOwnerStore.ts",
      "src/browser-gateway/webview/relay/relaySnapshotProjection.test.ts",
      "src/browser-gateway/webview/relay/relaySnapshotProjection.ts",
      "src/browser-gateway/webview/relay/useRelayGatewayConnection.test.ts",
      "src/browser-gateway/webview/relay/useRelayGatewayConnection.ts",
      "src/browser-gateway/dataPlane/protocol.test.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway owner-event compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "BrowserGatewayOwnerEvent",
      "BrowserGatewayOwnerEventPayload",
    ] as const;
    expect(compatibilitySource).toContain(
      'from "@agentlink/protocol/browser-gateway-owner-event";',
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/OwnerTransport.test.ts",
      "src/browser-gateway/dataPlane/OwnerTransport.ts",
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/helper/OwnerRelayStore.test.ts",
      "src/browser-gateway/helper/OwnerRelayStore.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.test.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.unit.test.ts",
      "src/browser-gateway/helper/relayRoutes.test.ts",
      "src/browser-gateway/testing/phase3LiveParityGate.ts",
      "src/browser-gateway/testing/phase3MobileBrowserFixture.ts",
      "src/browser-gateway/testing/phase3ReliabilityGate.ts",
      "src/browser-gateway/testing/stateEquivalenceOracle.ts",
      "src/browser-gateway/webview/relay/RelayConnectionManager.test.ts",
      "src/browser-gateway/webview/relay/RelayConnectionManager.ts",
      "src/browser-gateway/webview/relay/RelayOwnerStore.test.ts",
      "src/browser-gateway/webview/relay/RelayOwnerStore.ts",
      "src/browser-gateway/webview/relay/useRelayGatewayConnection.test.ts",
      "src/browser-gateway/webview/relay/useRelayGatewayConnection.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway owner-control compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayOwnerControl"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayOwnerControl } from "@agentlink/protocol/browser-gateway-owner-control";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+(?:interface|type)\s+BrowserGatewayOwnerControl\b(?:\s*=)?/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.test.ts",
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.ts",
      "src/browser-gateway/dataPlane/OwnerTransport.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway owner-command acknowledgement compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayOwnerCommandAck"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayOwnerCommandAck } from "@agentlink/protocol/browser-gateway-owner-command-ack";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+(?:interface|type)\s+BrowserGatewayOwnerCommandAck\b(?:\s*=)?/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.test.ts",
      "src/browser-gateway/dataPlane/OwnerTransport.ts",
      "src/browser-gateway/helper/commandRoutes.test.ts",
      "src/browser-gateway/helper/commandRoutes.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway owner-command compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayOwnerCommand"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayOwnerCommand } from "@agentlink/protocol/browser-gateway-owner-command";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+interface\s+BrowserGatewayOwnerCommand\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.test.ts",
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.ts",
      "src/browser-gateway/dataPlane/OwnerTransport.test.ts",
      "src/browser-gateway/dataPlane/OwnerTransport.ts",
      "src/browser-gateway/helper/AskAgentOwnerAdapter.test.ts",
      "src/browser-gateway/helper/AskAgentOwnerAdapter.ts",
      "src/browser-gateway/helper/commandRoutes.test.ts",
      "src/browser-gateway/helper/commandRoutes.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.test.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway owner-command body compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = ["BrowserGatewayOwnerCommandBody"] as const;
    expect(compatibilitySource).toContain(
      'export type { BrowserGatewayOwnerCommandBody } from "@agentlink/protocol/browser-gateway-owner-command-body";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+type\s+BrowserGatewayOwnerCommandBody\b(?:\s*=)?/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerCommandExecutor.ts",
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.ts",
      "src/browser-gateway/helper/AskAgentOwnerAdapter.test.ts",
      "src/browser-gateway/helper/commandRoutes.test.ts",
      "src/browser-gateway/helper/commandRoutes.ts",
      "src/browser-gateway/webview/relay/RelayConnectionManager.ts",
      "src/browser-gateway/webview/relay/useRelayGatewayConnection.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway foreground-control compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "BrowserGatewayForegroundControlState",
      "BrowserGatewayRevertRecoveryNotice",
    ] as const;
    expect(compatibilitySource).toContain(
      'from "@agentlink/protocol/browser-gateway-foreground-control-state";',
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/testing/stateEquivalenceOracle.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway session-catalog compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "BrowserGatewayProjectSummary",
      "BrowserGatewaySessionSummary",
      "BrowserGatewaySessionCatalog",
    ] as const;
    expect(compatibilitySource).toContain(
      'from "@agentlink/protocol/browser-gateway-session-catalog";',
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/testing/stateEquivalenceOracle.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway chat-workspace summary compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "BrowserGatewayChatTabStatus",
      "BrowserGatewayChatTabSummary",
      "BrowserGatewayChatWorkspaceSummary",
    ] as const;
    expect(compatibilitySource).toContain(
      'from "@agentlink/protocol/browser-gateway-chat-workspace-summary";',
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/BrowserGatewayService.ts",
      "src/browser-gateway/webview/BrowserGatewayApp.test.ts",
      "src/browser-gateway/webview/BrowserGatewayApp.tsx",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps the final Phase A2 DTO compatibility facades package-owned with bounded importers", () => {
    const closures = [
      {
        compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
        exportPath: "@agentlink/protocol/browser-gateway-data-plane-transport",
        extractedNames: [
          "BrowserGatewayChatTabSelection",
          "BrowserGatewayOwnerRegistration",
          "BrowserGatewayRelayReset",
        ],
        importerBaseline: ["src/browser-gateway/dataPlane/protocol.test.ts"],
      },
      {
        compatibilityPath:
          "src/browser-gateway/dataPlane/interactionPayload.ts",
        exportPath:
          "@agentlink/protocol/browser-gateway-owner-interaction-payload",
        extractedNames: [
          "BrowserGatewayOwnerInteractionPayload",
          "BrowserGatewayOwnerQuestionProgressPayload",
        ],
        importerBaseline: [
          "src/browser-gateway/dataPlane/ownerProjectionAdapter.test.ts",
          "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
          "src/browser-gateway/dataPlane/ownerProjectionSources.ts",
          "src/browser-gateway/helper/AskAgentOwnerAdapter.ts",
          "src/browser-gateway/webview/relay/relaySnapshotProjection.test.ts",
          "src/browser-gateway/webview/relay/relaySnapshotProjection.ts",
          "src/browser-gateway/webview/relay/useRelayGatewayConnection.ts",
        ],
      },
    ] as const;
    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );

    for (const closure of closures) {
      const compatibilityPath = path.join(ROOT, closure.compatibilityPath);
      const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
      expect(compatibilitySource).toContain(`from "${closure.exportPath}";`);
      for (const extractedName of closure.extractedNames) {
        expect(compatibilitySource, extractedName).not.toMatch(
          new RegExp(
            `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
          ),
        );
      }

      const importers = findCompatibilityImporters({
        compatibilityPath,
        sourceFiles,
        extractedNames: closure.extractedNames,
      });
      const importerBaseline = new Set<string>(closure.importerBaseline);
      // Compatibility imports may decrease during A4, but new importers are forbidden.
      expect(
        importers.every((importer) => importerBaseline.has(importer)),
      ).toBe(true);
      expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
    }
  });

  it("keeps browser-gateway data-plane version compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION",
    ] as const;
    expect(compatibilitySource).toContain(
      'export { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "@agentlink/protocol/browser-gateway-data-plane-version";',
    );
    expect(compatibilitySource).not.toMatch(
      /export\s+const\s+BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION\b/,
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8") }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.test.ts",
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.ts",
      "src/browser-gateway/dataPlane/OwnerTransport.test.ts",
      "src/browser-gateway/dataPlane/OwnerTransport.ts",
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/dataPlane/protocol.test.ts",
      "src/browser-gateway/helper/AskAgentOwnerAdapter.test.ts",
      "src/browser-gateway/helper/AskAgentOwnerAdapter.ts",
      "src/browser-gateway/helper/OwnerRelayStore.test.ts",
      "src/browser-gateway/helper/OwnerRelayStore.ts",
      "src/browser-gateway/helper/browserGatewayHelper.ts",
      "src/browser-gateway/helper/browserGatewayRelay.integration.test.ts",
      "src/browser-gateway/helper/commandRoutes.test.ts",
      "src/browser-gateway/helper/commandRoutes.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.test.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.unit.test.ts",
      "src/browser-gateway/helper/relayRoutes.test.ts",
      "src/browser-gateway/helper/relayRoutes.ts",
      "src/browser-gateway/testing/phase3LiveParityGate.ts",
      "src/browser-gateway/testing/phase3ReliabilityGate.ts",
      "src/browser-gateway/webview/relay/RelayConnectionManager.test.ts",
      "src/browser-gateway/webview/relay/RelayConnectionManager.ts",
      "src/browser-gateway/webview/relay/RelayOwnerStore.test.ts",
      "src/browser-gateway/webview/relay/relaySnapshotProjection.test.ts",
      "src/browser-gateway/webview/relay/useRelayGatewayConnection.test.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway data-plane identity compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "BrowserGatewayDataPlaneIdentity",
      "BrowserGatewayDetailHandle",
    ] as const;
    expect(compatibilitySource).toContain(
      [
        "export type {",
        "  BrowserGatewayDataPlaneIdentity,",
        "  BrowserGatewayDetailHandle,",
        '} from "@agentlink/protocol/browser-gateway-data-plane-identity";',
      ].join("\n"),
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.test.ts",
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.ts",
      "src/browser-gateway/dataPlane/OwnerTransport.test.ts",
      "src/browser-gateway/dataPlane/OwnerTransport.ts",
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/dataPlane/protocol.test.ts",
      "src/browser-gateway/helper/AskAgentOwnerAdapter.test.ts",
      "src/browser-gateway/helper/AskAgentOwnerAdapter.ts",
      "src/browser-gateway/helper/OwnerRelayStore.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.test.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.ts",
      "src/browser-gateway/testing/phase3LiveParityGate.ts",
      "src/browser-gateway/testing/stateEquivalenceOracle.ts",
      "src/browser-gateway/webview/relay/RelayConnectionManager.ts",
      "src/browser-gateway/webview/relay/useRelayGatewayConnection.test.ts",
      "src/browser-gateway/webview/relay/useRelayGatewayConnection.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway instance-status compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/protocol.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const extractedNames = [
      "BrowserGatewayInstanceStatusKind",
      "BrowserGatewayInstanceStatusSummary",
    ] as const;
    expect(compatibilitySource).toContain(
      [
        "export type {",
        "  BrowserGatewayInstanceStatusKind,",
        "  BrowserGatewayInstanceStatusSummary,",
        '} from "@agentlink/protocol/browser-gateway-instance-status";',
      ].join("\n"),
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
      extractedNames,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/BrowserGatewayServer.ts",
      "src/browser-gateway/BrowserGatewayService.ts",
      "src/browser-gateway/helper/browserGatewayHelper.ts",
      "src/browser-gateway/webview/BrowserGatewayApp.tsx",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway model-provider identity compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/browserGatewayModelProviderIds.ts",
    );
    expect(fs.readFileSync(compatibilityPath, "utf8")).toBe(
      'export * from "@agentlink/protocol/browser-gateway-model-provider-identity";\n',
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/browserGatewayAskAgentSessionStore.ts",
      "src/browser-gateway/browserGatewayModelAuthLeaseStore.ts",
      "src/browser-gateway/browserGatewayModelCredentialCache.ts",
      "src/browser-gateway/helper/askAgentModelClient.ts",
      "src/browser-gateway/helper/browserGatewayHelper.ts",
      "src/extension.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway data-plane limits compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/dataPlane/limits.ts",
    );
    expect(fs.readFileSync(compatibilityPath, "utf8")).toBe(
      'export * from "@agentlink/protocol/browser-gateway-data-plane-limits";\n',
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/BrowserGatewayServer.test.ts",
      "src/browser-gateway/BrowserGatewayServer.ts",
      "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.ts",
      "src/browser-gateway/dataPlane/OwnerTransport.test.ts",
      "src/browser-gateway/dataPlane/OwnerTransport.ts",
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.test.ts",
      "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
      "src/browser-gateway/dataPlane/protocol.test.ts",
      "src/browser-gateway/dataPlane/protocol.ts",
      "src/browser-gateway/helper/OwnerRelayStore.ts",
      "src/browser-gateway/helper/RelaySseClientQueue.ts",
      "src/browser-gateway/helper/commandRoutes.test.ts",
      "src/browser-gateway/helper/commandRoutes.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.test.ts",
      "src/browser-gateway/helper/dataPlaneRoutes.ts",
      "src/browser-gateway/helper/relayRoutes.ts",
      "src/browser-gateway/testing/ownerDataPlaneLoadFixture.test.ts",
      "src/browser-gateway/testing/ownerDataPlaneLoadFixture.ts",
      "src/browser-gateway/testing/phase3LiveParityGate.test.ts",
      "src/browser-gateway/testing/phase3LiveParityGate.ts",
      "src/browser-gateway/testing/phase3PerformanceGate.test.ts",
      "src/browser-gateway/testing/phase3PerformanceGate.ts",
      "src/browser-gateway/testing/stateEquivalenceOracle.ts",
      "src/browser-gateway/webview/relay/RelayConnectionManager.ts",
      "src/browser-gateway/webview/relay/RelayOwnerStore.ts",
      "src/browser-gateway/webview/sessionDetailTransport.test.ts",
      "src/browser-gateway/webview/sessionDetailTransport.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps browser-gateway data-plane mode compatibility package-owned with bounded importers", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/browser-gateway/browserGatewayDataPlaneMode.ts",
    );
    expect(fs.readFileSync(compatibilityPath, "utf8")).toBe(
      'export * from "@agentlink/protocol/browser-gateway-data-plane-mode";\n',
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const importers = findCompatibilityImporters({
      compatibilityPath,
      sourceFiles,
    });
    const importerBaseline = new Set([
      "src/browser-gateway/BrowserGatewayServer.ts",
      "src/browser-gateway/browserGatewayDataPlaneMode.test.ts",
      "src/browser-gateway/browserGatewayRegistry.ts",
      "src/browser-gateway/helper/browserGatewayHelper.ts",
      "src/browser-gateway/protocol.ts",
      "src/browser-gateway/testing/phase3ShadowParityGate.ts",
      "src/browser-gateway/webview/BrowserGatewayApp.tsx",
      "src/browser-gateway/webview/index.tsx",
      "src/browser-gateway/webview/relay/relayClientSelection.ts",
      "src/extension.ts",
    ]);
    // Compatibility imports may decrease during A4, but new importers are forbidden.
    expect(importers.every((importer) => importerBaseline.has(importer))).toBe(
      true,
    );
    expect(importers.length).toBeLessThanOrEqual(importerBaseline.size);
  });

  it("keeps surface-model-message compatibility package-owned and unused", () => {
    const compatibilityPath = path.join(
      ROOT,
      "src/core/surfaceModelMessages.ts",
    );
    const compatibilitySource = fs.readFileSync(compatibilityPath, "utf8");
    const packageSource = fs.readFileSync(
      path.join(ROOT, "packages/core/src/surfaceModelMessages.ts"),
      "utf8",
    );
    expect(compatibilitySource).toBe(
      'export * from "@agentlink/core/surface-model-messages";\n',
    );
    const extractedNames = [
      "CoreSurfaceModelMediaItem",
      "CoreSurfaceModelMessage",
      "CoreSurfaceQuestionAnswerItem",
    ] as const;

    expect(packageSource).toContain(
      [
        "export type {",
        ...extractedNames.map((name) => `  ${name},`),
        '} from "@agentlink/protocol/surface-model-message";',
      ].join("\n"),
    );
    for (const extractedName of extractedNames) {
      expect(compatibilitySource, extractedName).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
        ),
      );
    }

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    expect(
      findCompatibilityImporters({
        compatibilityPath,
        sourceFiles,
        extractedNames,
      }),
    ).toEqual([]);
  });

  it("keeps terminal-security compatibility package-owned and unused", () => {
    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const facades = [
      {
        path: "src/core/capabilities/terminal.ts",
        extractedNames: [
          "AgentTerminalExecutionAuthority",
          "CommandExecutionPolicy",
          "ManagedNetworkDecision",
          "ManagedNetworkRequest",
          "TerminalExecutionApprovalRequirement",
          "TerminalExecutionAuthorityReason",
          "TerminalExecutionRouteContext",
          "TerminalExecutionRouteReason",
          "TerminalExecutionSecurityFailure",
          "TerminalExecutionSecuritySummary",
          "TerminalSandboxAttestationSummary",
          "TerminalSandboxPermissionIntent",
        ],
      },
      {
        path: "src/core/sandboxPolicy.ts",
        extractedNames: [
          "SandboxBackendCapabilities",
          "SandboxCapabilityRequest",
          "SandboxEnvironmentBudgetMetadata",
          "SandboxEnvironmentInheritance",
          "SandboxEnvironmentPolicySummary",
          "SandboxExecutionMetadata",
          "SandboxViolation",
          "SandboxViolationOperation",
        ],
      },
    ] as const;

    for (const facade of facades) {
      const compatibilityPath = path.join(ROOT, facade.path);
      const source = fs.readFileSync(compatibilityPath, "utf8");
      expect(source, facade.path).toContain(
        '} from "@agentlink/protocol/terminal-security";',
      );
      for (const extractedName of facade.extractedNames) {
        expect(source, `${facade.path}:${extractedName}`).not.toMatch(
          new RegExp(
            `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
          ),
        );
      }
      expect(
        findCompatibilityImporters({
          compatibilityPath,
          sourceFiles,
          extractedNames: facade.extractedNames,
        }),
        facade.path,
      ).toEqual([]);
    }
  });

  it("keeps terminal-surface compatibility package-owned with bounded importers", () => {
    const transportCompatibilityPath = path.join(
      ROOT,
      "src/terminal/terminalSurfaceProtocol.ts",
    );
    expect(fs.readFileSync(transportCompatibilityPath, "utf8")).toBe(
      'export * from "@agentlink/protocol/terminal-surface";\n',
    );

    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    const transportImporters = findCompatibilityImporters({
      compatibilityPath: transportCompatibilityPath,
      sourceFiles,
    });
    const dirtyTransportImporterBaseline = new Set([
      "src/terminal/HostTerminalSurfaceController.ts",
      "src/terminal/LiveHostTerminalSurfaceController.ts",
      "src/terminal/terminalSurfaceProtocol.test.ts",
      "src/terminal/webview/terminalWebviewController.test.ts",
      "src/terminal/webview/terminalWebviewController.ts",
    ]);
    expect(
      transportImporters.every((importer) =>
        dirtyTransportImporterBaseline.has(importer),
      ),
    ).toBe(true);
    expect(transportImporters.length).toBeLessThanOrEqual(
      dirtyTransportImporterBaseline.size,
    );

    const supportingFacades = [
      {
        path: "src/terminal/alternateScreenTracker.ts",
        extractedNames: ["AlternateScreenTransition"],
        expectedExport:
          'export type { AlternateScreenTransition } from "@agentlink/protocol/terminal-surface";',
      },
      {
        path: "src/terminal/hostTerminalBlocks.ts",
        extractedNames: [
          "HostTerminalBlock",
          "HostTerminalBlockState",
          "HostTerminalCommandBlock",
          "HostTerminalPromptBlock",
          "HostTerminalRawBlock",
        ],
        expectedExport: '} from "@agentlink/protocol/terminal-surface";',
      },
      {
        path: "src/terminal/terminalOutputPolicy.ts",
        extractedNames: [
          "TerminalOutputPolicyAction",
          "TerminalOutputPolicyDecision",
          "TerminalOutputPolicyReason",
        ],
        expectedExport: '} from "@agentlink/protocol/terminal-surface";',
      },
      {
        path: "src/terminal/shellIntegration.ts",
        extractedNames: ["ShellIntegrationMode"],
        expectedExport:
          'export type { ShellIntegrationMode } from "@agentlink/protocol/terminal-surface";',
      },
    ] as const;

    for (const facade of supportingFacades) {
      const compatibilityPath = path.join(ROOT, facade.path);
      const source = fs.readFileSync(compatibilityPath, "utf8");
      expect(source, facade.path).toContain(facade.expectedExport);
      for (const extractedName of facade.extractedNames) {
        expect(source, `${facade.path}:${extractedName}`).not.toMatch(
          new RegExp(
            `export\\s+(?:interface|type)\\s+${extractedName}\\b(?:\\s*=)?`,
          ),
        );
      }
      expect(
        findCompatibilityImporters({
          compatibilityPath,
          sourceFiles,
          extractedNames: facade.extractedNames,
        }),
        facade.path,
      ).toEqual([]);
    }
  });

  it("keeps terminal approval-mode compatibility package-owned", () => {
    const compatibilitySource = fs.readFileSync(
      path.join(ROOT, "src/core/capabilities/terminal.ts"),
      "utf8",
    );
    for (const typeName of [
      "TerminalApprovalModeSnapshot",
      "TerminalApprovalPolicy",
      "TerminalApprovalReviewer",
      "TerminalCommandApprovalPolicySnapshot",
      "TerminalExecutionPreset",
    ]) {
      expect(compatibilitySource).toContain(typeName);
    }
    expect(compatibilitySource).toContain(
      '} from "@agentlink/protocol/terminal";',
    );
    expect(compatibilitySource).not.toMatch(
      /export interface TerminalApprovalModeSnapshot/,
    );

    const extractedTypePattern =
      /\b(?:TerminalApprovalModeSnapshot|TerminalApprovalPolicy|TerminalApprovalReviewer|TerminalCommandApprovalPolicySnapshot|TerminalExecutionPreset)\b/;
    const importPattern =
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
    const dynamicImportPattern = /import\(["']([^"']+)["']\)\.([A-Za-z0-9_]+)/g;
    const importers: string[] = [];
    for (const filePath of walkTypeScriptFiles(path.join(ROOT, "src"))) {
      const relativePath = path.relative(ROOT, filePath);
      if (relativePath === "src/core/capabilities/terminal.ts") continue;
      const source = fs.readFileSync(filePath, "utf8");
      const isCompatibilitySpecifier = (specifier: string): boolean =>
        /(?:^|\/)core\/capabilities\/terminal(?:\.js)?$/.test(specifier) ||
        (path.dirname(relativePath) === "src/core/capabilities" &&
          /^\.\/terminal(?:\.js)?$/.test(specifier));
      const importsExtractedType = [...source.matchAll(importPattern)].some(
        (match) =>
          isCompatibilitySpecifier(match[2] ?? "") &&
          extractedTypePattern.test(match[1] ?? ""),
      );
      const dynamicallyImportsExtractedType = [
        ...source.matchAll(dynamicImportPattern),
      ].some(
        (match) =>
          isCompatibilitySpecifier(match[1] ?? "") &&
          extractedTypePattern.test(match[2] ?? ""),
      );
      if (importsExtractedType || dynamicallyImportsExtractedType) {
        importers.push(relativePath);
      }
    }
    expect(importers).toEqual([]);
  });

  it("keeps chat-state compatibility package-owned and test-only", () => {
    const webviewCompatibilitySource = fs.readFileSync(
      path.join(ROOT, "src/agent/webview/types.ts"),
      "utf8",
    );
    expect(webviewCompatibilitySource).toContain(
      "export type ChatState = ChatStateSnapshot;",
    );
    const hostCompatibilitySource = fs.readFileSync(
      path.join(ROOT, "src/agent/ChatViewProvider.ts"),
      "utf8",
    );
    expect(hostCompatibilitySource).toContain(
      'import("@agentlink/protocol/chat-state").ChatStateSnapshot;',
    );

    const importers: string[] = [];
    const importPattern =
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
    const dynamicImportPattern = /import\(["']([^"']+)["']\)\.([A-Za-z0-9_]+)/g;
    for (const filePath of walkTypeScriptFiles(path.join(ROOT, "src"))) {
      const relativePath = path.relative(ROOT, filePath);
      if (
        relativePath === "src/agent/webview/types.ts" ||
        relativePath === "src/agent/ChatViewProvider.ts"
      ) {
        continue;
      }
      const source = fs.readFileSync(filePath, "utf8");
      const isCompatibilitySpecifier = (specifier: string): boolean => {
        if (!specifier.startsWith(".")) {
          return /(?:^|\/)(?:agent\/webview\/types|agent\/ChatViewProvider)(?:\.js)?$/.test(
            specifier,
          );
        }
        const resolved = path.resolve(path.dirname(filePath), specifier);
        const withoutExtension = resolved.replace(/\.js$/, "");
        return (
          withoutExtension === path.join(ROOT, "src/agent/webview/types") ||
          withoutExtension === path.join(ROOT, "src/agent/ChatViewProvider")
        );
      };
      const importsCompatibilityType = [...source.matchAll(importPattern)].some(
        (match) =>
          /\bChatState\b/.test(match[1] ?? "") &&
          isCompatibilitySpecifier(match[2] ?? ""),
      );
      const dynamicallyImportsCompatibilityType = [
        ...source.matchAll(dynamicImportPattern),
      ].some(
        (match) =>
          match[2] === "ChatState" && isCompatibilitySpecifier(match[1] ?? ""),
      );
      if (importsCompatibilityType || dynamicallyImportsCompatibilityType) {
        importers.push(relativePath);
      }
    }
    expect(importers).toEqual(["src/agent/webview/types.test.ts"]);
  });

  it("keeps chat-session-history compatibility package-owned and test-only", () => {
    const compatibilitySource = fs.readFileSync(
      path.join(ROOT, "src/agent/webview/types.ts"),
      "utf8",
    );
    expect(compatibilitySource).toContain(
      "export type SessionSummary = ChatSessionHistorySummary;",
    );

    const importers: string[] = [];
    const importPattern =
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
    const dynamicImportPattern = /import\(["']([^"']+)["']\)\.([A-Za-z0-9_]+)/g;
    for (const filePath of walkTypeScriptFiles(path.join(ROOT, "src"))) {
      const relativePath = path.relative(ROOT, filePath);
      if (relativePath === "src/agent/webview/types.ts") continue;
      const source = fs.readFileSync(filePath, "utf8");
      const isCompatibilitySpecifier = (specifier: string): boolean => {
        if (!specifier.startsWith(".")) {
          return /(?:^|\/)agent\/webview\/types(?:\.js)?$/.test(specifier);
        }
        const resolved = path.resolve(path.dirname(filePath), specifier);
        return (
          resolved.replace(/\.js$/, "") ===
          path.join(ROOT, "src/agent/webview/types")
        );
      };
      const importsCompatibilityType = [...source.matchAll(importPattern)].some(
        (match) =>
          /\bSessionSummary\b/.test(match[1] ?? "") &&
          isCompatibilitySpecifier(match[2] ?? ""),
      );
      const dynamicallyImportsCompatibilityType = [
        ...source.matchAll(dynamicImportPattern),
      ].some(
        (match) =>
          match[2] === "SessionSummary" &&
          isCompatibilitySpecifier(match[1] ?? ""),
      );
      if (importsCompatibilityType || dynamicallyImportsCompatibilityType) {
        importers.push(relativePath);
      }
    }
    expect(importers).toEqual(["src/agent/webview/types.test.ts"]);
  });

  it("keeps chat-transcript compatibility package-owned and test-only", () => {
    const compatibilitySource = fs.readFileSync(
      path.join(ROOT, "src/agent/webview/types.ts"),
      "utf8",
    );
    for (const alias of [
      "export type ContentBlock = ProtocolContentBlock;",
      "export type ChatMessage = ProtocolChatMessage;",
      "export type TodoItem = ProtocolTodoItem;",
    ]) {
      expect(compatibilitySource).toContain(alias);
    }

    const extractedTypePattern = /\b(?:ChatMessage|ContentBlock|TodoItem)\b/;
    const importPattern =
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
    const dynamicImportPattern = /import\(["']([^"']+)["']\)\.([A-Za-z0-9_]+)/g;
    const importers: string[] = [];
    for (const filePath of walkTypeScriptFiles(path.join(ROOT, "src"))) {
      const relativePath = path.relative(ROOT, filePath);
      if (
        relativePath === "src/agent/webview/types.ts" ||
        relativePath === "src/protocolPackageBoundary.test.ts"
      ) {
        continue;
      }
      const source = fs.readFileSync(filePath, "utf8");
      const isCompatibilitySpecifier = (specifier: string): boolean => {
        if (!specifier.startsWith(".")) {
          return /(?:^|\/)agent\/webview\/types(?:\.js)?$/.test(specifier);
        }
        const resolved = path.resolve(path.dirname(filePath), specifier);
        const withoutExtension = resolved.replace(/\.js$/, "");
        return withoutExtension === path.join(ROOT, "src/agent/webview/types");
      };
      const importsExtractedType = [...source.matchAll(importPattern)].some(
        (match) =>
          isCompatibilitySpecifier(match[2] ?? "") &&
          extractedTypePattern.test(match[1] ?? ""),
      );
      const dynamicallyImportsExtractedType = [
        ...source.matchAll(dynamicImportPattern),
      ].some(
        (match) =>
          isCompatibilitySpecifier(match[1] ?? "") &&
          extractedTypePattern.test(match[2] ?? ""),
      );
      if (importsExtractedType || dynamicallyImportsExtractedType) {
        importers.push(relativePath);
      }
    }
    expect(importers).toEqual(["src/agent/webview/types.test.ts"]);

    const duplicateDeclarations: string[] = [];
    for (const filePath of walkTypeScriptFiles(path.join(ROOT, "src"))) {
      const relativePath = path.relative(ROOT, filePath);
      if (
        relativePath === "src/agent/webview/types.ts" ||
        relativePath === "src/protocolPackageBoundary.test.ts"
      ) {
        continue;
      }
      const source = fs.readFileSync(filePath, "utf8");
      if (
        /(?:export\s+)?interface\s+(?:TodoItem|ChatMessage)\b/.test(source) ||
        /(?:export\s+)?type\s+ContentBlock\s*=/.test(source)
      ) {
        duplicateDeclarations.push(relativePath);
      }
    }
    expect(duplicateDeclarations).toEqual(["src/agent/providers/types.ts"]);
  });

  it("keeps structured-question compatibility package-owned and test-only", () => {
    const coreCompatibilitySource = fs.readFileSync(
      path.join(ROOT, "src/core/capabilities/sessionControl.ts"),
      "utf8",
    );
    expect(coreCompatibilitySource).toContain(
      '} from "@agentlink/protocol/structured-question";',
    );
    const webviewCompatibilitySource = fs.readFileSync(
      path.join(ROOT, "src/agent/webview/types.ts"),
      "utf8",
    );
    expect(webviewCompatibilitySource).toContain(
      "export type Question = UserQuestion;",
    );
    expect(webviewCompatibilitySource).toContain(
      "export type QuestionRequest = StructuredQuestionRequest;",
    );

    const extractedTypePattern = new RegExp(
      `\\b(?:${[
        "normalizeUserQuestionAttachments",
        "Question",
        "QuestionRequest",
        "StructuredQuestionProgress",
        "StructuredQuestionRequest",
        "UserQuestion",
        "UserQuestionAnswer",
        "UserQuestionAttachment",
        "UserQuestionRequest",
        "UserQuestionResponse",
        "UserQuestionType",
      ].join("|")})\\b`,
    );
    const importPattern =
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
    const dynamicImportPattern = /import\(["']([^"']+)["']\)\.([A-Za-z0-9_]+)/g;
    const importers: string[] = [];
    for (const filePath of walkTypeScriptFiles(path.join(ROOT, "src"))) {
      const relativePath = path.relative(ROOT, filePath);
      if (
        relativePath === "src/core/capabilities/sessionControl.ts" ||
        relativePath === "src/agent/webview/types.ts"
      ) {
        continue;
      }
      const source = fs.readFileSync(filePath, "utf8");
      const isCompatibilitySpecifier = (specifier: string): boolean =>
        /(?:^|\/)(?:core\/capabilities\/sessionControl|agent\/webview\/types)(?:\.js)?$/.test(
          specifier,
        ) ||
        (path.dirname(relativePath) === "src/core/capabilities" &&
          /^\.\/sessionControl(?:\.js)?$/.test(specifier)) ||
        (path.dirname(relativePath) === "src/agent/webview" &&
          /^\.\/types(?:\.js)?$/.test(specifier));
      const importsExtractedType = [...source.matchAll(importPattern)].some(
        (match) =>
          isCompatibilitySpecifier(match[2] ?? "") &&
          extractedTypePattern.test(match[1] ?? ""),
      );
      const dynamicallyImportsExtractedType = [
        ...source.matchAll(dynamicImportPattern),
      ].some(
        (match) =>
          isCompatibilitySpecifier(match[1] ?? "") &&
          extractedTypePattern.test(match[2] ?? ""),
      );
      if (importsExtractedType || dynamicallyImportsExtractedType) {
        importers.push(relativePath);
      }
    }
    expect(importers).toEqual([
      "src/agent/webview/types.test.ts",
      "src/core/capabilities/sessionControl.test.ts",
    ]);
  });

  it("keeps agent error presentation compatibility package-owned and test-only", () => {
    const sharedCompatibilitySource = fs.readFileSync(
      path.join(ROOT, "src/shared/agentErrors.ts"),
      "utf8",
    );
    expect(sharedCompatibilitySource).toContain(
      '} from "@agentlink/protocol/agent-error-presentation";',
    );
    const agentCompatibilitySource = fs.readFileSync(
      path.join(ROOT, "src/agent/types.ts"),
      "utf8",
    );
    expect(agentCompatibilitySource).toContain(
      'export type { AgentErrorActions } from "@agentlink/protocol/agent-error-presentation";',
    );
    expect(agentCompatibilitySource).toContain(
      "export type AgentRuntimeError = AgentRuntimeErrorPresentation;",
    );

    const extractedTypePattern =
      /\b(?:AgentErrorActions|AgentRuntimeErrorPresentation)\b/;
    const importPattern =
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
    const importers: string[] = [];
    for (const filePath of walkTypeScriptFiles(path.join(ROOT, "src"))) {
      const relativePath = path.relative(ROOT, filePath);
      if (
        relativePath === "src/shared/agentErrors.ts" ||
        relativePath === "src/agent/types.ts"
      ) {
        continue;
      }
      const source = fs.readFileSync(filePath, "utf8");
      const importsExtractedType = [...source.matchAll(importPattern)].some(
        (match) => {
          const specifier = match[2] ?? "";
          const importsCompatibilityPath =
            /(?:^|\/)(?:shared\/agentErrors|agent\/types)(?:\.js)?$/.test(
              specifier,
            ) ||
            (path.dirname(relativePath) === "src/shared" &&
              /^\.\/agentErrors(?:\.js)?$/.test(specifier)) ||
            (path.dirname(relativePath) === "src/agent" &&
              /^\.\/types(?:\.js)?$/.test(specifier));
          return (
            importsCompatibilityPath &&
            extractedTypePattern.test(match[1] ?? "")
          );
        },
      );
      if (importsExtractedType) importers.push(relativePath);
    }
    expect(importers).toEqual(["src/shared/agentErrors.test.ts"]);
  });

  it("keeps mixed-module compatibility exports package-owned and test-only", () => {
    const compatibilitySource = fs.readFileSync(
      path.join(ROOT, "src/shared/types.ts"),
      "utf8",
    );
    for (const expectedExport of MIXED_COMPATIBILITY_EXPORTS) {
      expect(compatibilitySource).toContain(expectedExport);
    }

    const forbiddenTypePattern = new RegExp(
      `\\b(?:${MIXED_COMPATIBILITY_TYPE_NAMES.join("|")})\\b`,
    );
    const importPattern =
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
    const dynamicImportPattern = /import\(["']([^"']+)["']\)\.([A-Za-z0-9_]+)/g;
    const importers: string[] = [];
    for (const filePath of walkTypeScriptFiles(path.join(ROOT, "src"))) {
      const relativePath = path.relative(ROOT, filePath);
      if (relativePath === "src/shared/types.ts") continue;
      const source = fs.readFileSync(filePath, "utf8");
      const importsExtractedType = [...source.matchAll(importPattern)].some(
        (match) =>
          isMixedCompatibilityImportPath(relativePath, match[2] ?? "") &&
          forbiddenTypePattern.test(match[1] ?? ""),
      );
      const dynamicallyImportsExtractedType = [
        ...source.matchAll(dynamicImportPattern),
      ].some(
        (match) =>
          isMixedCompatibilityImportPath(relativePath, match[1] ?? "") &&
          forbiddenTypePattern.test(match[2] ?? ""),
      );
      if (importsExtractedType || dynamicallyImportsExtractedType) {
        importers.push(relativePath);
      }
    }
    expect(importers).toEqual(["src/shared/types.test.ts"]);
  });

  it("allows no new imports of legacy protocol shims", () => {
    const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
      (filePath) => ({
        filePath,
        source: fs.readFileSync(filePath, "utf8"),
      }),
    );
    for (const shim of LEGACY_SHIMS) {
      const importers: string[] = [];
      for (const { filePath, source } of sourceFiles) {
        if (path.join(ROOT, shim.path) === filePath) continue;
        if (shim.importPattern.test(source)) {
          importers.push(path.relative(ROOT, filePath));
        }
      }
      expect(importers, shim.path).toEqual([shim.allowedImporter]);
    }
  });
});

function findCompatibilityImporters(options: {
  compatibilityPath: string;
  sourceFiles: ReadonlyArray<{ filePath: string; source: string }>;
  extractedNames?: readonly string[];
}): string[] {
  const compatibilityModule = options.compatibilityPath.replace(/\.tsx?$/, "");
  const extractedNamePattern = options.extractedNames
    ? new RegExp(`\\b(?:${options.extractedNames.join("|")})\\b`)
    : undefined;
  const staticNamedImportOrExportPattern =
    /(?:import|export)\s+(?:type\s+)?(?:[A-Za-z_$][A-Za-z0-9_$]*\s*,\s*)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
  const dynamicPropertyImportPattern =
    /import\s*\(\s*["']([^"']+)["']\s*\)\s*\.\s*([A-Za-z0-9_]+)/g;
  const dynamicNamespaceImportPattern =
    /import\s*\(\s*["']([^"']+)["']\s*\)(?!\s*\.)/g;
  const namespaceImportPattern =
    /import\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["']([^"']+)["']/g;
  const bareExportPattern =
    /export\s+(?:type\s+)?\*(?:\s+as\s+[A-Za-z0-9_$]+)?\s+from\s+["']([^"']+)["']/g;
  const importers: string[] = [];

  for (const { filePath, source } of options.sourceFiles) {
    if (
      filePath === options.compatibilityPath ||
      filePath === path.join(ROOT, "src/protocolPackageBoundary.test.ts")
    ) {
      continue;
    }
    const isCompatibilitySpecifier = (specifier: string): boolean => {
      if (!specifier.startsWith(".")) {
        const relativeModule = path
          .relative(ROOT, compatibilityModule)
          .replaceAll(path.sep, "/");
        return new RegExp(
          `(?:^|/)${escapeRegExp(relativeModule)}(?:\\.js)?$`,
        ).test(specifier);
      }
      return (
        path.resolve(path.dirname(filePath), specifier).replace(/\.js$/, "") ===
        compatibilityModule
      );
    };
    const staticallyImportsOrExports = [
      ...source.matchAll(staticNamedImportOrExportPattern),
    ].some(
      (match) =>
        isCompatibilitySpecifier(match[2] ?? "") &&
        (!extractedNamePattern || extractedNamePattern.test(match[1] ?? "")),
    );
    const dynamicallyImports = [
      ...source.matchAll(dynamicPropertyImportPattern),
    ].some(
      (match) =>
        isCompatibilitySpecifier(match[1] ?? "") &&
        (!extractedNamePattern || extractedNamePattern.test(match[2] ?? "")),
    );
    const dynamicallyImportsNamespace = [
      ...source.matchAll(dynamicNamespaceImportPattern),
    ].some((match) => isCompatibilitySpecifier(match[1] ?? ""));
    const namespaceImports = [...source.matchAll(namespaceImportPattern)].some(
      (match) => {
        if (!isCompatibilitySpecifier(match[2] ?? "")) return false;
        if (!extractedNamePattern) return true;
        const namespaceName = match[1] ?? "";
        const extractedNames = options.extractedNames!.join("|");
        const directlyAccessesExtractedName = new RegExp(
          `\\b${escapeRegExp(namespaceName)}\\s*(?:\\.\\s*(?:${extractedNames})\\b|\\[\\s*["'](?:${extractedNames})["']\\s*\\])`,
        ).test(source);
        if (directlyAccessesExtractedName) return true;
        const sourceWithoutImport = source.replace(match[0], "");
        return new RegExp(
          `\\b${escapeRegExp(namespaceName)}\\b(?!\\s*[.\\[])`,
        ).test(sourceWithoutImport);
      },
    );
    const bareReexports = [...source.matchAll(bareExportPattern)].some(
      (match) => isCompatibilitySpecifier(match[1] ?? ""),
    );
    if (
      staticallyImportsOrExports ||
      dynamicallyImports ||
      dynamicallyImportsNamespace ||
      namespaceImports ||
      bareReexports
    ) {
      importers.push(path.relative(ROOT, filePath));
    }
  }

  return importers.sort();
}

async function containsNodeGlobalIdentifier(source: string): Promise<boolean> {
  const { createScanner, SyntaxKind } = await typescriptAst;
  const scanner = createScanner(true, undefined, source);
  const forbiddenIdentifiers = new Set([
    "process",
    "Buffer",
    "__dirname",
    "__filename",
  ]);
  for (
    let token = scanner.scan();
    token !== SyntaxKind.EndOfFile;
    token = scanner.scan()
  ) {
    if (
      token === SyntaxKind.Identifier &&
      forbiddenIdentifiers.has(scanner.getTokenText())
    ) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMixedCompatibilityImportPath(
  importerPath: string,
  specifier: string,
): boolean {
  return (
    /(?:^|\/)shared\/types(?:\.js)?$/.test(specifier) ||
    (path.dirname(importerPath) === "src/shared" &&
      /^\.\/types(?:\.js)?$/.test(specifier))
  );
}

function listPackageDirectories(): string[] {
  const packagesDirectory = path.join(ROOT, "packages");
  return fs
    .readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesDirectory, entry.name))
    .filter((directory) => fs.existsSync(path.join(directory, "src")))
    .sort();
}

function walkTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkTypeScriptFiles(candidate));
    else if (entry.isFile() && /\.tsx?$/.test(candidate)) files.push(candidate);
  }
  return files.sort();
}
