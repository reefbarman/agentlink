import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { build } from "esbuild";

const ROOT = path.resolve(__dirname, "..");
const PROTOCOL_SOURCE = path.join(ROOT, "packages", "protocol", "src");
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
      'export type { CoreModelAuthProvider } from "./modelAuthProvider.js";',
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

const FORBIDDEN_PROTOCOL_PATTERNS = [
  { pattern: /from\s+["']vscode["']/, label: "VS Code" },
  {
    pattern:
      /from\s+["'](?:node:)?(?:fs|path|os|crypto|child_process|net|http|https|stream|buffer)["']/,
    label: "Node API",
  },
  {
    pattern: /\b(?:process|Buffer|__dirname|__filename)\b/,
    label: "Node global",
  },
  { pattern: /["'][^"']*(?:^|\/)src\//, label: "root src" },
];

describe("protocol package boundary", () => {
  it("keeps production protocol modules browser-safe and independent from root source", () => {
    const violations: string[] = [];

    for (const filePath of walkTypeScriptFiles(PROTOCOL_SOURCE)) {
      if (filePath.endsWith(".test.ts")) continue;
      const source = fs.readFileSync(filePath, "utf8");
      for (const rule of FORBIDDEN_PROTOCOL_PATTERNS) {
        if (rule.pattern.test(source)) {
          violations.push(
            `${path.relative(ROOT, filePath)}: contains ${rule.label}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("bundles every public protocol module for a browser without Node fallbacks", async () => {
    const result = await build({
      entryPoints: [
        path.join(PROTOCOL_SOURCE, "agentErrorPresentation.ts"),
        path.join(PROTOCOL_SOURCE, "agentPluginManager.ts"),
        path.join(PROTOCOL_SOURCE, "autoContinueProgress.ts"),
        path.join(PROTOCOL_SOURCE, "autonomousMemory.ts"),
        path.join(PROTOCOL_SOURCE, "backgroundResult.ts"),
        path.join(PROTOCOL_SOURCE, "browserGatewayTheme.ts"),
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
        path.join(PROTOCOL_SOURCE, "questionConfirmation.ts"),
        path.join(PROTOCOL_SOURCE, "questionDetection.ts"),
        path.join(PROTOCOL_SOURCE, "selectionCommands.ts"),
        path.join(PROTOCOL_SOURCE, "semanticReadiness.ts"),
        path.join(PROTOCOL_SOURCE, "session.ts"),
        path.join(PROTOCOL_SOURCE, "sessionHandoffDraft.ts"),
        path.join(PROTOCOL_SOURCE, "structuredQuestion.ts"),
        path.join(PROTOCOL_SOURCE, "sessionHydration.ts"),
        path.join(PROTOCOL_SOURCE, "sidebarTransport.ts"),
        path.join(PROTOCOL_SOURCE, "terminal.ts"),
        path.join(PROTOCOL_SOURCE, "terminalSurface.ts"),
        path.join(PROTOCOL_SOURCE, "todoContinuation.ts"),
        path.join(PROTOCOL_SOURCE, "toolResult.ts"),
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
    /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
  const dynamicPropertyImportPattern =
    /import\s*\(\s*["']([^"']+)["']\s*\)\s*\.\s*([A-Za-z0-9_]+)/g;
  const namespaceImportPattern =
    /import\s+\*\s+as\s+[A-Za-z0-9_]+\s+from\s+["']([^"']+)["']/g;
  const bareExportPattern =
    /export\s+\*(?:\s+as\s+[A-Za-z0-9_$]+)?\s+from\s+["']([^"']+)["']/g;
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
    const namespaceImports = [...source.matchAll(namespaceImportPattern)].some(
      (match) => isCompatibilitySpecifier(match[1] ?? ""),
    );
    const bareReexports = [...source.matchAll(bareExportPattern)].some(
      (match) => isCompatibilitySpecifier(match[1] ?? ""),
    );
    if (
      staticallyImportsOrExports ||
      dynamicallyImports ||
      namespaceImports ||
      bareReexports
    ) {
      importers.push(path.relative(ROOT, filePath));
    }
  }

  return importers.sort();
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
