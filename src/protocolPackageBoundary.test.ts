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

/** A check against the built `packages/protocol/dist/cjs` output. */
type ProtocolModuleDistCheck =
  /** `index.d.cts` re-exports the module. */
  | "rootDeclaration"
  /** `<fileName>.cjs` exists. */
  | "cjsFile"
  /** `index.cjs` exists. */
  | "rootCjsFile"
  /** `require("@agentlink/protocol")` does not throw. */
  | "requireRoot"
  /** `require("@agentlink/protocol/<exportPath>")` does not throw. */
  | "requireSubpath";

interface ProtocolModuleWiringContext {
  wiring: ProtocolModuleWiring;
  /** Loads the built CommonJS module for this row's subpath export. */
  requireSubpath: () => unknown;
  /** Loads the built CommonJS root module. */
  requireRoot: () => unknown;
}

/**
 * How one `packages/protocol` module must be wired through the package
 * manifest, the root index, both CJS build scripts and the built output.
 * `checkProtocolModuleWiring` applies a row; only the fields a row sets are
 * asserted.
 */
interface ProtocolModuleWiring {
  /**
   * Test title. Defaults to `wires <exportPath> through every public package
   * build surface`. Rows sharing a title run in one test.
   */
  title?: string;
  /** Subpath export name, as in `@agentlink/protocol/<exportPath>`. */
  exportPath: string;
  /** Source module name, as in `packages/protocol/src/<fileName>.ts`. */
  fileName: string;
  /**
   * `standard` (default): the export entry has the exact browser/import/require
   * shape for `fileName`. `present`: the export entry only has to exist.
   */
  manifest?: "standard" | "present";
  /**
   * `root`: `src/index.ts` re-exports the module. `subpath-only`: the index
   * documents it as subpath-only and does not re-export it.
   */
  index: "root" | "subpath-only";
  /**
   * What both build scripts must say about the generated CJS root index:
   * `export-star` contains `export * from "./<fileName>.cjs";\n` (escaped
   * newline); `quoted-specifier` contains `"./<fileName>.cjs"`;
   * `no-export-star` and `no-quoted-specifier` must not contain those;
   * `unchecked` asserts nothing.
   */
  cjsRootReexport:
    | "export-star"
    | "quoted-specifier"
    | "no-export-star"
    | "no-quoted-specifier"
    | "unchecked";
  /** `false` skips the `"dist/cjs/<fileName>.d.cts"` build-script check. */
  declarationOutput?: false;
  /** Build scripts contain `readFile("dist/<fileName>.d.ts", "utf8")`. */
  readsEsmDeclaration?: true;
  /** Literal text both build scripts must contain. */
  buildScriptContains?: readonly string[];
  /**
   * Modules whose `.js` specifier both build scripts rewrite to `.cjs`, and
   * which the built `.d.cts` must import as `from "./<dependency>.cjs";`.
   */
  rewrittenDependencies?: readonly string[];
  /** Patterns both whitespace-normalised build scripts must match. */
  normalizedBuildScriptMatches?: readonly RegExp[];
  /** Checks against the built CJS output. */
  dist?: readonly ProtocolModuleDistCheck[];
  /** Literal text the built `<fileName>.d.cts` must contain. */
  declarationContains?: readonly string[];
  /** Exported runtime arrays: exact values and whether they are frozen. */
  runtimeLists?: readonly {
    name: string;
    values: readonly string[];
    frozen: boolean;
  }[];
  /** Assertions specific to this module that fit no field above. */
  extra?: (context: ProtocolModuleWiringContext) => void;
}

const FULL_DIST_CHECKS = [
  "rootDeclaration",
  "cjsFile",
  "requireRoot",
  "requireSubpath",
] as const satisfies readonly ProtocolModuleDistCheck[];

const PHASE_A2_BATCH_WIRING_TITLE =
  "wires the final Phase A2 browser-gateway DTO batch through every public package surface";
const COMMAND_METADATA_AND_OPERATION_STATE_WIRING_TITLE =
  "wires browser-gateway command metadata and operation state through every public package build surface";
const EMBEDDED_AGENT_TRANSPORT_WIRING_TITLE =
  "wires embedded-agent transport through every public package build surface";

const PROTOCOL_MODULE_WIRINGS: readonly ProtocolModuleWiring[] = [
  {
    title: PHASE_A2_BATCH_WIRING_TITLE,
    exportPath: "browser-gateway-data-plane-transport",
    fileName: "browserGatewayDataPlaneTransport",
    index: "root",
    cjsRootReexport: "export-star",
    buildScriptContains: [
      `'"./browserGatewayCapabilityStatus.cjs"'`,
      `'"./browserGatewayDataPlaneIdentity.cjs"'`,
      `'"./browserGatewayOwnerControlMetadata.cjs"'`,
      `'"./browserGatewayDataPlaneVersion.cjs"'`,
    ],
    dist: ["cjsFile", "requireSubpath"],
    declarationContains: [
      'from "./browserGatewayCapabilityStatus.cjs"',
      'from "./browserGatewayDataPlaneIdentity.cjs"',
      'from "./browserGatewayOwnerControlMetadata.cjs"',
      'from "./browserGatewayDataPlaneVersion.cjs"',
    ],
  },
  {
    title: PHASE_A2_BATCH_WIRING_TITLE,
    exportPath: "browser-gateway-owner-interaction-payload",
    fileName: "browserGatewayOwnerInteractionPayload",
    index: "root",
    cjsRootReexport: "export-star",
    buildScriptContains: [
      `'"./approvalTransport.cjs"'`,
      `'"./mcpElicitation.cjs"'`,
      `'"./mcpUrlElicitation.cjs"'`,
      `'"./structuredQuestion.cjs"'`,
    ],
    dist: ["cjsFile", "requireSubpath"],
    declarationContains: [
      'from "./approvalTransport.cjs"',
      'from "./mcpElicitation.cjs"',
      'from "./mcpUrlElicitation.cjs"',
      'from "./structuredQuestion.cjs"',
    ],
  },
  {
    exportPath: "approval-transport",
    fileName: "approvalTransport",
    index: "subpath-only",
    cjsRootReexport: "no-export-star",
  },
  {
    exportPath: "web-access-policy",
    fileName: "webAccessPolicy",
    index: "root",
    cjsRootReexport: "export-star",
    readsEsmDeclaration: true,
    normalizedBuildScriptMatches: [
      /readFile\("dist\/webAccessPolicy\.d\.ts", "utf8"\)\.then\(\(content\) => writeFile\( "dist\/cjs\/webAccessPolicy\.d\.cts", content\.replaceAll\(\s*'"\.\/webActivity\.js"'\s*,\s*'"\.\/webActivity\.cjs"'\s*,?\s*\), \), \)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: ['from "./webActivity.cjs";'],
  },
  {
    exportPath: "web-activity",
    fileName: "webActivity",
    index: "root",
    cjsRootReexport: "export-star",
    dist: FULL_DIST_CHECKS,
    declarationContains: ["export interface CoreWebActivity"],
  },
  {
    exportPath: "provider-replay",
    fileName: "providerReplay",
    index: "root",
    cjsRootReexport: "export-star",
    dist: FULL_DIST_CHECKS,
    declarationContains: ["export interface CoreProviderReplayEnvelope"],
  },
  {
    exportPath: "retrieval-deletion",
    fileName: "retrievalDeletion",
    index: "root",
    cjsRootReexport: "export-star",
    readsEsmDeclaration: true,
    normalizedBuildScriptMatches: [
      /readFile\("dist\/retrievalDeletion\.d\.ts", "utf8"\)\.then\(\(content\) => writeFile\( "dist\/cjs\/retrievalDeletion\.d\.cts", content\.replaceAll\(\s*'"\.\/retrievalRecords\.js"'\s*,\s*'"\.\/retrievalRecords\.cjs"'\s*,?\s*\), \), \)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: ['from "./retrievalRecords.cjs";'],
  },
  {
    exportPath: "retrieval-fingerprint",
    fileName: "retrievalFingerprint",
    index: "root",
    cjsRootReexport: "export-star",
  },
  {
    exportPath: "retrieval-maintenance",
    fileName: "retrievalMaintenance",
    index: "root",
    cjsRootReexport: "export-star",
    dist: [
      "rootDeclaration",
      "cjsFile",
      "rootCjsFile",
      "requireRoot",
      "requireSubpath",
    ],
    declarationContains: ["export interface RetrievalAggregateMetrics"],
  },
  {
    exportPath: "retrieval-structural-snapshot",
    fileName: "retrievalStructuralSnapshot",
    index: "root",
    cjsRootReexport: "export-star",
    readsEsmDeclaration: true,
    normalizedBuildScriptMatches: [
      /content \.replaceAll\(\s*'"\.\/retrievalFingerprint\.js"'\s*,\s*'"\.\/retrievalFingerprint\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/retrievalQuery\.js"'\s*,\s*'"\.\/retrievalQuery\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/retrievalRecords\.js"'\s*,\s*'"\.\/retrievalRecords\.cjs"'\s*,?\s*\)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: [
      'from "./retrievalFingerprint.cjs";',
      'from "./retrievalQuery.cjs";',
      'from "./retrievalRecords.cjs";',
    ],
  },
  {
    exportPath: "retrieval-health",
    fileName: "retrievalHealth",
    index: "root",
    cjsRootReexport: "export-star",
    readsEsmDeclaration: true,
    normalizedBuildScriptMatches: [
      /content\.replaceAll\(\s*'"\.\/retrievalFingerprint\.js"'\s*,\s*'"\.\/retrievalFingerprint\.cjs"'\s*,?\s*\)/,
      /content\.replaceAll\(\s*'"\.\/retrievalHealth\.js"'\s*,\s*'"\.\/retrievalHealth\.cjs"'\s*,?\s*\)/,
    ],
  },
  {
    exportPath: "retrieval-publication",
    fileName: "retrievalPublication",
    index: "root",
    cjsRootReexport: "export-star",
    readsEsmDeclaration: true,
    normalizedBuildScriptMatches: [
      /readFile\("dist\/retrievalPublication\.d\.ts", "utf8"\)\.then\(\(content\) => writeFile\( "dist\/cjs\/retrievalPublication\.d\.cts", content\.replaceAll\(\s*'"\.\/retrievalRecords\.js"'\s*,\s*'"\.\/retrievalRecords\.cjs"'\s*,?\s*\), \), \)/,
    ],
  },
  {
    exportPath: "retrieval-query",
    fileName: "retrievalQuery",
    index: "root",
    cjsRootReexport: "export-star",
    readsEsmDeclaration: true,
    normalizedBuildScriptMatches: [
      /readFile\("dist\/retrievalQuery\.d\.ts", "utf8"\)\.then\(\(content\) => writeFile\( "dist\/cjs\/retrievalQuery\.d\.cts", content \.replaceAll\(\s*'"\.\/retrievalHealth\.js"'\s*,\s*'"\.\/retrievalHealth\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/retrievalRecords\.js"'\s*,\s*'"\.\/retrievalRecords\.cjs"'\s*,?\s*\), \), \)/,
    ],
  },
  {
    exportPath: "retrieval-records",
    fileName: "retrievalRecords",
    index: "root",
    cjsRootReexport: "export-star",
  },
  {
    exportPath: "session-handoff-draft",
    fileName: "sessionHandoffDraft",
    index: "root",
    cjsRootReexport: "quoted-specifier",
  },
  {
    exportPath: "sidebar-transport",
    fileName: "sidebarTransport",
    index: "subpath-only",
    cjsRootReexport: "no-quoted-specifier",
  },
  {
    exportPath: "browser-gateway-ask-agent-identity",
    fileName: "browserGatewayAskAgentIdentity",
    index: "root",
    cjsRootReexport: "export-star",
    dist: FULL_DIST_CHECKS,
    declarationContains: [
      "export declare function isBrowserGatewayAskAgentSessionId",
    ],
  },
  {
    exportPath: "browser-gateway-core-owner-registration",
    fileName: "browserGatewayCoreOwnerRegistration",
    index: "root",
    cjsRootReexport: "export-star",
    normalizedBuildScriptMatches: [
      /\.replaceAll\('"\.\/session\.js"', '"\.\/session\.cjs"'\)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: ['from "./session.cjs";'],
  },
  {
    exportPath: "browser-gateway-helper-lifecycle",
    fileName: "browserGatewayHelperLifecycle",
    index: "root",
    cjsRootReexport: "export-star",
    normalizedBuildScriptMatches: [
      /\.replaceAll\( '"\.\/browserGatewayDataPlaneMode\.js"', '"\.\/browserGatewayDataPlaneMode\.cjs"', \)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: ['from "./browserGatewayDataPlaneMode.cjs";'],
  },
  {
    title:
      "wires browser-gateway relay theme state through the existing public package surface",
    exportPath: "browser-gateway-theme",
    fileName: "browserGatewayTheme",
    index: "root",
    cjsRootReexport: "export-star",
    dist: ["rootDeclaration"],
    declarationContains: ["export interface BrowserGatewayThemeState"],
    runtimeLists: [
      {
        name: "BROWSER_GATEWAY_COLOR_SCHEMES",
        values: ["light", "dark", "hc", "hc-light"],
        frozen: true,
      },
    ],
  },
  {
    exportPath: "browser-gateway-background-summary",
    fileName: "browserGatewayBackgroundSummary",
    index: "root",
    cjsRootReexport: "export-star",
    dist: FULL_DIST_CHECKS,
    declarationContains: ["export interface BrowserGatewayBackgroundSummary"],
  },
  {
    exportPath: "browser-gateway-transcript-window",
    fileName: "browserGatewayTranscriptWindow",
    index: "root",
    cjsRootReexport: "export-star",
    normalizedBuildScriptMatches: [
      /readFile\("dist\/browserGatewayTranscriptWindow\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayTranscriptWindow\.d\.cts", content\.replaceAll\(\s*'"\.\/browserGatewayTranscriptMessage\.js"'\s*,\s*'"\.\/browserGatewayTranscriptMessage\.cjs"'\s*,?\s*\), \), \)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: [
      'import type { BrowserGatewayTranscriptMessage } from "./browserGatewayTranscriptMessage.cjs";',
    ],
  },
  {
    exportPath: "browser-gateway-transcript-message",
    fileName: "browserGatewayTranscriptMessage",
    index: "root",
    cjsRootReexport: "export-star",
    normalizedBuildScriptMatches: [
      /readFile\("dist\/browserGatewayTranscriptMessage\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayTranscriptMessage\.d\.cts", content \.replaceAll\(\s*'"\.\/chatTranscript\.js"'\s*,\s*'"\.\/chatTranscript\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/browserGatewayTranscriptBlock\.js"'\s*,\s*'"\.\/browserGatewayTranscriptBlock\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/browserGatewayTranscriptText\.js"'\s*,\s*'"\.\/browserGatewayTranscriptText\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/toolResult\.js"'\s*,\s*'"\.\/toolResult\.cjs"'\s*,?\s*\), \), \)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: [
      'from "./chatTranscript.cjs";',
      'from "./browserGatewayTranscriptBlock.cjs";',
      'from "./browserGatewayTranscriptText.cjs";',
      'from "./toolResult.cjs";',
    ],
  },
  {
    exportPath: "browser-gateway-transcript-block",
    fileName: "browserGatewayTranscriptBlock",
    index: "root",
    cjsRootReexport: "export-star",
    normalizedBuildScriptMatches: [
      /readFile\("dist\/browserGatewayTranscriptBlock\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayTranscriptBlock\.d\.cts", content \.replaceAll\(\s*'"\.\/backgroundResult\.js"'\s*,\s*'"\.\/backgroundResult\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/browserGatewayTranscriptText\.js"'\s*,\s*'"\.\/browserGatewayTranscriptText\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/chatTranscript\.js"'\s*,\s*'"\.\/chatTranscript\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/modelCatalog\.js"'\s*,\s*'"\.\/modelCatalog\.cjs"'\s*,?\s*\), \), \)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: [
      'from "./backgroundResult.cjs";',
      'from "./browserGatewayTranscriptText.cjs";',
      'from "./chatTranscript.cjs";',
      'from "./modelCatalog.cjs";',
    ],
  },
  {
    exportPath: "browser-gateway-transcript-text",
    fileName: "browserGatewayTranscriptText",
    index: "root",
    cjsRootReexport: "export-star",
    normalizedBuildScriptMatches: [
      /readFile\("dist\/browserGatewayTranscriptText\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayTranscriptText\.d\.cts", content\.replaceAll\(\s*'"\.\/browserGatewayDataPlaneIdentity\.js"'\s*,\s*'"\.\/browserGatewayDataPlaneIdentity\.cjs"'\s*,?\s*\), \), \)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: [
      'import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.cjs";',
    ],
  },
  {
    exportPath: "browser-gateway-detached-session-selection",
    fileName: "browserGatewayDetachedSessionSelection",
    index: "root",
    cjsRootReexport: "export-star",
    dist: ["rootDeclaration", "requireRoot", "requireSubpath"],
    declarationContains: [
      "export interface BrowserGatewayDetachedSessionSelection",
    ],
  },
  {
    exportPath: "browser-gateway-diff-preview",
    fileName: "browserGatewayDiffPreview",
    index: "root",
    cjsRootReexport: "export-star",
    normalizedBuildScriptMatches: [
      /readFile\("dist\/browserGatewayDiffPreview\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayDiffPreview\.d\.cts", content\.replaceAll\(\s*'"\.\/browserGatewayDataPlaneIdentity\.js"'\s*,\s*'"\.\/browserGatewayDataPlaneIdentity\.cjs"'\s*,?\s*\), \), \)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: [
      'import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.cjs";',
    ],
  },
  {
    exportPath: "browser-gateway-interaction-state",
    fileName: "browserGatewayInteractionState",
    index: "root",
    cjsRootReexport: "export-star",
    normalizedBuildScriptMatches: [
      /readFile\("dist\/browserGatewayInteractionState\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayInteractionState\.d\.cts", content \.replaceAll\(\s*'"\.\/browserGatewayInteractionSummary\.js"'\s*,\s*'"\.\/browserGatewayInteractionSummary\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/browserGatewayOperationState\.js"'\s*,\s*'"\.\/browserGatewayOperationState\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/browserGatewayQueueItem\.js"'\s*,\s*'"\.\/browserGatewayQueueItem\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/browserGatewayTodoItem\.js"'\s*,\s*'"\.\/browserGatewayTodoItem\.cjs"'\s*,?\s*\), \), \)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: [
      'from "./browserGatewayInteractionSummary.cjs";',
      'from "./browserGatewayOperationState.cjs";',
      'from "./browserGatewayQueueItem.cjs";',
      'from "./browserGatewayTodoItem.cjs";',
    ],
  },
  {
    exportPath: "browser-gateway-interaction-summary",
    fileName: "browserGatewayInteractionSummary",
    index: "root",
    cjsRootReexport: "export-star",
    normalizedBuildScriptMatches: [
      /readFile\("dist\/browserGatewayInteractionSummary\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayInteractionSummary\.d\.cts", content\.replaceAll\(\s*'"\.\/browserGatewayDataPlaneIdentity\.js"'\s*,\s*'"\.\/browserGatewayDataPlaneIdentity\.cjs"'\s*,?\s*\), \), \)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: [
      'import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.cjs";',
    ],
  },
  {
    title:
      "wires browser-gateway owner-control metadata through every public package build surface",
    exportPath: "browser-gateway-owner-control-metadata",
    fileName: "browserGatewayOwnerControlMetadata",
    index: "root",
    cjsRootReexport: "export-star",
    dist: ["rootDeclaration", "cjsFile", "requireRoot"],
    declarationContains: [
      "export declare const BROWSER_GATEWAY_OWNER_CONTROL_KINDS",
    ],
    runtimeLists: [
      {
        name: "BROWSER_GATEWAY_OWNER_CONTROL_KINDS",
        values: [
          "hello",
          "demand.changed",
          "checkpoint.requested",
          "command.cancelled",
          "drain",
        ],
        frozen: false,
      },
      {
        name: "BROWSER_GATEWAY_RELAY_RESET_REASONS",
        values: [
          "helper_generation_changed",
          "owner_generation_changed",
          "sequence_gap",
          "stale_replay_cursor",
          "subscription_changed",
          "checkpoint_required",
        ],
        frozen: true,
      },
    ],
  },
  {
    title:
      "wires browser-gateway owner-event metadata through every public package build surface",
    exportPath: "browser-gateway-owner-event-metadata",
    fileName: "browserGatewayOwnerEventMetadata",
    index: "root",
    cjsRootReexport: "export-star",
    dist: ["rootDeclaration", "cjsFile", "requireRoot"],
    declarationContains: [
      "export declare const BROWSER_GATEWAY_OWNER_EVENT_KINDS",
    ],
    runtimeLists: [
      {
        name: "BROWSER_GATEWAY_OWNER_EVENT_KINDS",
        values: [
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
        ],
        frozen: true,
      },
    ],
  },
  {
    title: COMMAND_METADATA_AND_OPERATION_STATE_WIRING_TITLE,
    exportPath: "browser-gateway-owner-command-metadata",
    fileName: "browserGatewayOwnerCommandMetadata",
    index: "root",
    cjsRootReexport: "export-star",
    dist: ["rootDeclaration", "cjsFile", "requireSubpath"],
  },
  {
    title: COMMAND_METADATA_AND_OPERATION_STATE_WIRING_TITLE,
    exportPath: "browser-gateway-operation-state",
    fileName: "browserGatewayOperationState",
    index: "root",
    cjsRootReexport: "export-star",
    normalizedBuildScriptMatches: [
      /readFile\("dist\/browserGatewayOperationState\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayOperationState\.d\.cts", content \.replaceAll\(\s*'"\.\/browserGatewayDataPlaneIdentity\.js"'\s*,\s*'"\.\/browserGatewayDataPlaneIdentity\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/browserGatewayOwnerCommandMetadata\.js"'\s*,\s*'"\.\/browserGatewayOwnerCommandMetadata\.cjs"'\s*,?\s*\), \), \)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: [
      'from "./browserGatewayDataPlaneIdentity.cjs";',
      'from "./browserGatewayOwnerCommandMetadata.cjs";',
    ],
  },
  {
    exportPath: "browser-gateway-todo-item",
    fileName: "browserGatewayTodoItem",
    index: "root",
    cjsRootReexport: "export-star",
    dist: ["rootDeclaration"],
    declarationContains: ["export interface BrowserGatewayTodoItem"],
    runtimeLists: [
      {
        name: "BROWSER_GATEWAY_TODO_ITEM_STATES",
        values: ["pending", "in_progress", "completed"],
        frozen: true,
      },
    ],
  },
  {
    exportPath: "browser-gateway-queue-item",
    fileName: "browserGatewayQueueItem",
    index: "root",
    cjsRootReexport: "export-star",
    dist: ["rootDeclaration"],
    declarationContains: ["export interface BrowserGatewayQueueItem"],
    runtimeLists: [
      {
        name: "BROWSER_GATEWAY_QUEUE_ITEM_STATES",
        values: ["queued", "running", "completed", "failed"],
        frozen: true,
      },
    ],
  },
  {
    exportPath: "browser-gateway-repository-state",
    fileName: "browserGatewayRepositoryState",
    index: "root",
    cjsRootReexport: "export-star",
    dist: FULL_DIST_CHECKS,
    declarationContains: ["export interface BrowserGatewayRepositoryState"],
  },
  {
    exportPath: "browser-gateway-context-budget",
    fileName: "browserGatewayContextBudget",
    index: "root",
    cjsRootReexport: "export-star",
    dist: FULL_DIST_CHECKS,
    declarationContains: ["export interface BrowserGatewayContextBudget"],
  },
  {
    exportPath: "browser-gateway-capability-status",
    fileName: "browserGatewayCapabilityStatus",
    index: "root",
    cjsRootReexport: "export-star",
    dist: ["rootDeclaration", "cjsFile", "requireRoot"],
    declarationContains: ["export interface BrowserGatewayCapabilityStatus"],
    runtimeLists: [
      {
        name: "BROWSER_GATEWAY_CAPABILITY_STATES",
        values: ["enabled", "disabled", "requires_approval", "unavailable"],
        frozen: true,
      },
    ],
  },
  {
    exportPath: "browser-gateway-protocol-error",
    fileName: "browserGatewayProtocolError",
    index: "root",
    cjsRootReexport: "export-star",
    dist: ["rootDeclaration"],
    declarationContains: [
      "export declare class BrowserGatewayProtocolError extends Error",
    ],
    extra: checkBrowserGatewayProtocolErrorRuntime,
  },
  {
    exportPath: "browser-gateway-owner-publication-batch",
    fileName: "browserGatewayOwnerPublicationBatch",
    index: "root",
    cjsRootReexport: "export-star",
    rewrittenDependencies: [
      "browserGatewayDataPlaneIdentity",
      "browserGatewayDataPlaneVersion",
      "browserGatewayOwnerCheckpoint",
      "browserGatewayOwnerEvent",
    ],
    dist: FULL_DIST_CHECKS,
  },
  {
    exportPath: "browser-gateway-owner-checkpoint",
    fileName: "browserGatewayOwnerCheckpoint",
    index: "root",
    cjsRootReexport: "export-star",
    rewrittenDependencies: [
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
    ],
    dist: FULL_DIST_CHECKS,
  },
  {
    exportPath: "browser-gateway-owner-event",
    fileName: "browserGatewayOwnerEvent",
    index: "root",
    cjsRootReexport: "export-star",
    rewrittenDependencies: [
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
    ],
    dist: FULL_DIST_CHECKS,
  },
  {
    exportPath: "browser-gateway-owner-control",
    fileName: "browserGatewayOwnerControl",
    index: "root",
    cjsRootReexport: "export-star",
    rewrittenDependencies: [
      "browserGatewayDataPlaneIdentity",
      "browserGatewayDataPlaneVersion",
      "browserGatewayOwnerControlMetadata",
    ],
    dist: FULL_DIST_CHECKS,
  },
  {
    exportPath: "browser-gateway-owner-command-ack",
    fileName: "browserGatewayOwnerCommandAck",
    index: "root",
    cjsRootReexport: "export-star",
    rewrittenDependencies: [
      "browserGatewayDataPlaneIdentity",
      "browserGatewayDataPlaneVersion",
      "browserGatewayOperationState",
    ],
    dist: FULL_DIST_CHECKS,
  },
  {
    exportPath: "browser-gateway-owner-command",
    fileName: "browserGatewayOwnerCommand",
    index: "root",
    cjsRootReexport: "export-star",
    rewrittenDependencies: [
      "browserGatewayDataPlaneIdentity",
      "browserGatewayDataPlaneVersion",
      "browserGatewayOwnerCommandBody",
      "browserGatewayOwnerCommandMetadata",
    ],
    dist: FULL_DIST_CHECKS,
  },
  {
    exportPath: "browser-gateway-owner-command-body",
    fileName: "browserGatewayOwnerCommandBody",
    index: "root",
    cjsRootReexport: "export-star",
    normalizedBuildScriptMatches: [
      /readFile\("dist\/browserGatewayOwnerCommandBody\.d\.ts", "utf8"\)\.then\(\s*(?:\(content\)|content) =>\s*writeFile\( "dist\/cjs\/browserGatewayOwnerCommandBody\.d\.cts", content\.replaceAll\(\s*'"\.\/browserGatewayDataPlaneIdentity\.js"'\s*,\s*'"\.\/browserGatewayDataPlaneIdentity\.cjs"'\s*,?\s*\), \), \)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: [
      'import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.cjs";',
    ],
  },
  {
    exportPath: "browser-gateway-foreground-control-state",
    fileName: "browserGatewayForegroundControlState",
    index: "root",
    cjsRootReexport: "export-star",
    rewrittenDependencies: [
      "terminal",
      "browserGatewayContextBudget",
      "chatWorkspace",
      "commandApprovalPolicy",
      "contextHealth",
      "modelCatalog",
      "sessionHydration",
    ],
    dist: FULL_DIST_CHECKS,
  },
  {
    exportPath: "browser-gateway-session-catalog",
    fileName: "browserGatewaySessionCatalog",
    index: "root",
    cjsRootReexport: "export-star",
    normalizedBuildScriptMatches: [
      /readFile\("dist\/browserGatewaySessionCatalog\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewaySessionCatalog\.d\.cts", content\.replaceAll\(\s*'"\.\/browserGatewayChatWorkspaceSummary\.js"'\s*,\s*'"\.\/browserGatewayChatWorkspaceSummary\.cjs"'\s*,?\s*\), \), \)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: [
      'import type { BrowserGatewayChatWorkspaceSummary } from "./browserGatewayChatWorkspaceSummary.cjs";',
    ],
  },
  {
    exportPath: "browser-gateway-chat-workspace-summary",
    fileName: "browserGatewayChatWorkspaceSummary",
    index: "root",
    cjsRootReexport: "export-star",
    normalizedBuildScriptMatches: [
      /readFile\(\s*"dist\/browserGatewayChatWorkspaceSummary\.d\.ts",\s*"utf8",?\s*\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayChatWorkspaceSummary\.d\.cts", content\.replaceAll\(\s*'"\.\/chatWorkspace\.js"'\s*,\s*'"\.\/chatWorkspace\.cjs"'\s*,?\s*\), \), \)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: [
      'import type { ChatWorkspaceInteractiveExecutionPhase } from "./chatWorkspace.cjs";',
    ],
  },
  {
    exportPath: "browser-gateway-data-plane-version",
    fileName: "browserGatewayDataPlaneVersion",
    index: "root",
    cjsRootReexport: "export-star",
    dist: ["rootDeclaration", "requireRoot"],
    declarationContains: [
      'export declare const BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION = "1";',
    ],
    extra: checkBrowserGatewayDataPlaneVersionRuntime,
  },
  {
    exportPath: "browser-gateway-data-plane-identity",
    fileName: "browserGatewayDataPlaneIdentity",
    index: "root",
    cjsRootReexport: "export-star",
    dist: ["rootDeclaration", "cjsFile", "requireRoot"],
    declarationContains: ["export interface BrowserGatewayDetailHandle"],
    runtimeLists: [
      {
        name: "BROWSER_GATEWAY_DETAIL_HANDLE_KINDS",
        values: ["message", "tool", "diff", "media", "interaction", "session"],
        frozen: true,
      },
    ],
  },
  {
    exportPath: "browser-gateway-instance-status",
    fileName: "browserGatewayInstanceStatus",
    index: "root",
    cjsRootReexport: "export-star",
    dist: FULL_DIST_CHECKS,
    declarationContains: [
      "export interface BrowserGatewayInstanceStatusSummary",
    ],
  },
  {
    exportPath: "browser-gateway-model-provider-identity",
    fileName: "browserGatewayModelProviderIdentity",
    index: "root",
    cjsRootReexport: "export-star",
    dist: FULL_DIST_CHECKS,
    declarationContains: [
      "export declare function normalizeBrowserGatewayModelCredentialProviderId",
    ],
  },
  {
    exportPath: "browser-gateway-data-plane-limits",
    fileName: "browserGatewayDataPlaneLimits",
    index: "root",
    cjsRootReexport: "export-star",
    normalizedBuildScriptMatches: [
      /readFile\("dist\/browserGatewayDataPlaneLimits\.d\.ts", "utf8"\)\.then\(\s*\(content\) => writeFile\( "dist\/cjs\/browserGatewayDataPlaneLimits\.d\.cts", content \.replaceAll\(\s*'"\.\/browserGatewayDataPlaneIdentity\.js"'\s*,\s*'"\.\/browserGatewayDataPlaneIdentity\.cjs"'\s*,?\s*\) \.replaceAll\(\s*'"\.\/browserGatewayOwnerCommandMetadata\.js"'\s*,\s*'"\.\/browserGatewayOwnerCommandMetadata\.cjs"'\s*,?\s*\), \), \)/,
    ],
    dist: FULL_DIST_CHECKS,
    declarationContains: [
      'from "./browserGatewayDataPlaneIdentity.cjs";',
      "export type BrowserGatewayDataPlaneLimitName",
    ],
  },
  {
    exportPath: "browser-gateway-data-plane-mode",
    fileName: "browserGatewayDataPlaneMode",
    index: "root",
    cjsRootReexport: "export-star",
    dist: FULL_DIST_CHECKS,
    declarationContains: ["export type BrowserGatewayDataPlaneMode"],
  },
  {
    exportPath: "surface-model-message",
    fileName: "surfaceModelMessage",
    index: "root",
    cjsRootReexport: "export-star",
    dist: FULL_DIST_CHECKS,
    declarationContains: ["export interface CoreSurfaceModelMessage"],
  },
  {
    exportPath: "terminal-security",
    fileName: "terminalSecurity",
    index: "root",
    cjsRootReexport: "quoted-specifier",
  },
  {
    exportPath: "terminal-surface",
    fileName: "terminalSurface",
    index: "root",
    cjsRootReexport: "quoted-specifier",
  },
  {
    exportPath: "diff-snapshot",
    fileName: "diffSnapshot",
    index: "root",
    cjsRootReexport: "quoted-specifier",
  },
  {
    title: EMBEDDED_AGENT_TRANSPORT_WIRING_TITLE,
    exportPath: "embedded-agent-presentation",
    fileName: "embeddedAgentPresentation",
    index: "root",
    cjsRootReexport: "unchecked",
    declarationOutput: false,
  },
  {
    title: EMBEDDED_AGENT_TRANSPORT_WIRING_TITLE,
    exportPath: "embedded-agent-transport",
    fileName: "embeddedAgentTransport",
    index: "root",
    cjsRootReexport: "quoted-specifier",
  },
  {
    exportPath: "chat-pane-transport",
    fileName: "chatPaneTransport",
    index: "root",
    cjsRootReexport: "quoted-specifier",
  },
  {
    exportPath: "find-replace-preview",
    fileName: "findReplacePreview",
    index: "subpath-only",
    cjsRootReexport: "unchecked",
  },
  {
    exportPath: "chat-state",
    fileName: "chatState",
    manifest: "present",
    index: "root",
    cjsRootReexport: "quoted-specifier",
  },
  {
    exportPath: "chat-session-history",
    fileName: "chatSessionHistory",
    manifest: "present",
    index: "root",
    cjsRootReexport: "quoted-specifier",
  },
  {
    exportPath: "chat-transcript",
    fileName: "chatTranscript",
    manifest: "present",
    index: "root",
    cjsRootReexport: "quoted-specifier",
  },
];

/**
 * A root `src/` file that only forwards package-owned contracts, plus who may
 * still import those contracts through it. `checkCompatibilityFacade` applies
 * a row; only the fields a row sets are asserted.
 */
interface CompatibilityFacade {
  /** Test title. Rows sharing a title run in one test. */
  title: string;
  /** Root-relative path of the compatibility file. */
  compatibilityPath: string;
  /** Exact content of the compatibility file. */
  sourceIs?: string;
  /** Literal text the compatibility file must contain. */
  sourceContains?: readonly string[];
  /** Patterns the compatibility file must not match. */
  sourceNotMatching?: readonly RegExp[];
  /** A package file that must contain the given literal text. */
  packageSource?: { path: string; contains: readonly string[] };
  /**
   * Names the package now owns. When set, only imports of these names through
   * the compatibility file count as importers.
   */
  extractedNames?: readonly string[];
  /**
   * Builds, per extracted name, a pattern for a local declaration the
   * compatibility file must not contain.
   */
  forbiddenLocalDeclaration?: (extractedName: string) => RegExp;
  /**
   * `unused`: nothing may import through the compatibility file. `baseline`:
   * importers must all be in the list and may not outnumber it.
   */
  importers: "unused" | { baseline: readonly string[] };
}

const PHASE_A2_FACADES_TITLE =
  "keeps the final Phase A2 DTO compatibility facades package-owned with bounded importers";
const TERMINAL_SECURITY_FACADES_TITLE =
  "keeps terminal-security compatibility package-owned and unused";
const TERMINAL_SURFACE_FACADES_TITLE =
  "keeps terminal-surface compatibility package-owned with bounded importers";

const COMPATIBILITY_FACADES: readonly CompatibilityFacade[] = [
  {
    title: "keeps approval-transport compatibility package-owned and unused",
    compatibilityPath: "src/approvals/webview/types.ts",
    sourceIs: [
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
    importers: "unused",
  },
  {
    title:
      "keeps web-access-policy compatibility package-owned with bounded importers",
    compatibilityPath: "src/core/webAccess.ts",
    sourceIs: 'export * from "@agentlink/core/web-access";\n',
    packageSource: {
      path: "packages/core/src/webAccess.ts",
      contains: [
        [
          "export type {",
          "  CoreHostedToolDefinition,",
          "  CoreHostedWebCapabilities,",
          "  CoreHostedWebFetchDefinition,",
          "  CoreHostedWebSearchDefinition,",
          "  CoreHostedWebToolCapability,",
          "  CoreResolveWebAccessPolicyInput,",
          "  CoreResolvedWebAccessPolicy,",
          "  CoreResolvedWebAccessRoute,",
          "  CoreWebAccessResolutionReason,",
          "  CoreWebAccessSelection,",
          "  CoreWebAccessSettings,",
          "  CoreWebAccessSettingsInput,",
          "  CoreWebSearchMode,",
          '} from "@agentlink/protocol/web-access-policy";',
        ].join("\n"),
      ],
    },
    extractedNames: [
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
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: {
      baseline: [
        "src/agent/AgentSessionManager.ts",
        "src/agent/ChatViewProvider.ts",
        "src/browser-gateway/helper/browserGatewayHelper.ts",
      ],
    },
  },
  {
    title:
      "keeps web-activity compatibility package-owned with bounded importers",
    compatibilityPath: "src/core/webAccess.ts",
    sourceIs: 'export * from "@agentlink/core/web-access";\n',
    packageSource: {
      path: "packages/core/src/webAccess.ts",
      contains: ['} from "@agentlink/protocol/web-activity";'],
    },
    extractedNames: [
      "CoreWebAccessBackend",
      "CoreWebActivity",
      "CoreWebActivityStatus",
      "CoreWebCitation",
      "CoreWebToolKind",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: {
      baseline: [
        "src/agent/toolAdapter.ts",
        "src/browser-gateway/helper/browserGatewayHelper.ts",
        "src/core/tools/types.ts",
        "src/shared/chatProjection.ts",
      ],
    },
  },
  {
    title: "keeps provider-replay compatibility package-owned and unused",
    compatibilityPath: "src/core/webAccess.ts",
    sourceIs: 'export * from "@agentlink/core/web-access";\n',
    packageSource: {
      path: "packages/core/src/webAccess.ts",
      contains: [
        [
          "export type {",
          "  CoreJsonValue,",
          "  CoreProviderReplayEnvelope,",
          '} from "@agentlink/protocol/provider-replay";',
        ].join("\n"),
      ],
    },
    extractedNames: ["CoreJsonValue", "CoreProviderReplayEnvelope"],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: "unused",
  },
  {
    title: "keeps retrieval-deletion compatibility package-owned and unused",
    compatibilityPath: "src/core/retrieval/contracts.ts",
    sourceContains: ['} from "@agentlink/protocol/retrieval-deletion";'],
    extractedNames: [
      "RetrievalDeleteScopeOutcome",
      "RetrievalDeleteScopeRequest",
      "RetrievalDeleteSourceOutcome",
      "RetrievalDeleteSourceRequest",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: "unused",
  },
  {
    title: "keeps retrieval-fingerprint compatibility package-owned and unused",
    compatibilityPath: "src/core/retrieval/contracts.ts",
    sourceContains: ['} from "@agentlink/protocol/retrieval-fingerprint";'],
    extractedNames: [
      "RetrievalEmbeddingFingerprint",
      "RetrievalFingerprint",
      "RetrievalFingerprintDisposition",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: "unused",
  },
  {
    title: "keeps retrieval-publication compatibility package-owned and unused",
    compatibilityPath: "src/core/retrieval/contracts.ts",
    sourceContains: ['} from "@agentlink/protocol/retrieval-publication";'],
    extractedNames: [
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
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: "unused",
  },
  {
    title: "keeps retrieval-query compatibility package-owned and unused",
    compatibilityPath: "src/core/retrieval/contracts.ts",
    sourceContains: ['} from "@agentlink/protocol/retrieval-query";'],
    extractedNames: [
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
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: "unused",
  },
  {
    title: "keeps retrieval-records compatibility package-owned and unused",
    compatibilityPath: "src/core/retrieval/contracts.ts",
    sourceContains: ['} from "@agentlink/protocol/retrieval-records";'],
    extractedNames: [
      "RetrievalChunkLocation",
      "RetrievalChunkRecord",
      "RetrievalNamespace",
      "RetrievalRelationRecord",
      "RetrievalSourceDocument",
      "RetrievalSourceKind",
      "RetrievalSourceRevision",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: "unused",
  },
  {
    title: "keeps retrieval-maintenance compatibility package-owned and unused",
    compatibilityPath: "src/core/retrieval/contracts.ts",
    sourceContains: ['} from "@agentlink/protocol/retrieval-maintenance";'],
    extractedNames: [
      "RetrievalAggregateMetrics",
      "RetrievalMigrationOutcome",
      "RetrievalOptimizeOutcome",
      "RetrievalRepairOutcome",
      "RetrievalSnapshot",
      "RetrievalSnapshotOutcome",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: "unused",
  },
  {
    title:
      "keeps retrieval-structural-snapshot compatibility package-owned and unused",
    compatibilityPath: "src/core/retrieval/contracts.ts",
    sourceContains: [
      '} from "@agentlink/protocol/retrieval-structural-snapshot";',
    ],
    extractedNames: [
      "RetrievalActiveSource",
      "RetrievalStructuralSnapshot",
      "RetrievalStructuralSnapshotRequest",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: "unused",
  },
  {
    title:
      "keeps retrieval-health compatibility package-owned with bounded importers",
    compatibilityPath: "src/core/retrieval/contracts.ts",
    sourceContains: ['} from "@agentlink/protocol/retrieval-health";'],
    extractedNames: [
      "RetrievalHealthReason",
      "RetrievalHealthSnapshot",
      "RetrievalLexicalReadiness",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: { baseline: ["src/agent/ChatViewProvider.ts"] },
  },
  {
    title: "keeps sidebar-transport compatibility package-owned and unused",
    compatibilityPath: "src/sidebar/webview/types.ts",
    sourceIs: [
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
    importers: "unused",
  },
  {
    title:
      "keeps browser Ask Agent identity compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/browserGatewayAskAgentIdentity.ts",
    sourceIs:
      'export * from "@agentlink/protocol/browser-gateway-ask-agent-identity";\n',
    importers: {
      baseline: [
        "src/browser-gateway/browserGatewayAskAgentSessionStore.ts",
        "src/browser-gateway/helper/browserGatewayHelper.ts",
        "src/browser-gateway/webview/BrowserGatewayApp.test.ts",
        "src/browser-gateway/webview/BrowserGatewayApp.tsx",
        "src/browser-gateway/webview/relay/relayClientSelection.test.ts",
        "src/browser-gateway/webview/relay/useRelayGatewayConnection.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway core-owner registration compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/coreOwnerRegistry.ts",
    sourceContains: [
      '} from "@agentlink/protocol/browser-gateway-core-owner-registration";',
      "export class BrowserGatewayCoreOwnerRegistry",
      "export interface BrowserGatewayCoreOwnerRegistryOptions",
    ],
    extractedNames: [
      "BrowserGatewayCoreOwnerHeartbeat",
      "BrowserGatewayCoreOwnerRegistration",
      "BrowserGatewayCoreOwnerRegistrationResolution",
      "BrowserGatewayCoreOwnerRegistrationResult",
      "BrowserGatewayCoreOwnerStatus",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/OwnerTransport.ts",
        "src/browser-gateway/protocol.ts",
        "src/browser-gateway/testing/GatewayGenerationFaultHarness.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway helper lifecycle compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/protocol.ts",
    sourceContains: [
      [
        "export {",
        "  BROWSER_GATEWAY_DATA_PLANE_FEATURES,",
        "  BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,",
        '} from "@agentlink/protocol/browser-gateway-helper-lifecycle";',
      ].join("\n"),
      [
        "export type {",
        "  BrowserGatewayDataPlaneFeature,",
        "  BrowserGatewayHelperDiscoveryRecord,",
        "  BrowserGatewayHelperHealthResponse,",
        '} from "@agentlink/protocol/browser-gateway-helper-lifecycle";',
      ].join("\n"),
    ],
    extractedNames: [
      "BROWSER_GATEWAY_DATA_PLANE_FEATURES",
      "BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION",
      "BrowserGatewayDataPlaneFeature",
      "BrowserGatewayHelperDiscoveryRecord",
      "BrowserGatewayHelperHealthResponse",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type|const"),
    importers: {
      baseline: [
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
      ],
    },
  },
  {
    title:
      "keeps browser-gateway capability-status compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayCapabilityStatus } from "@agentlink/protocol/browser-gateway-capability-status";',
    ],
    sourceNotMatching: [
      /export\s+interface\s+BrowserGatewayCapabilityStatus\b/,
    ],
    extractedNames: ["BrowserGatewayCapabilityStatus"],
    importers: {
      baseline: ["src/browser-gateway/dataPlane/ownerProjectionAdapter.ts"],
    },
  },
  {
    title:
      "keeps browser-gateway relay theme-state compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      [
        "export type {",
        "  BrowserGatewayThemeState,",
        "  BrowserGatewayThemeVariable,",
        '} from "@agentlink/protocol/browser-gateway-theme";',
      ].join("\n"),
    ],
    extractedNames: ["BrowserGatewayThemeState", "BrowserGatewayThemeVariable"],
    forbiddenLocalDeclaration: exportedInterfaceDeclaration,
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
        "src/browser-gateway/testing/stateEquivalenceOracle.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway background-summary compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayBackgroundSummary } from "@agentlink/protocol/browser-gateway-background-summary";',
    ],
    sourceNotMatching: [
      /export\s+interface\s+BrowserGatewayBackgroundSummary\b/,
    ],
    extractedNames: ["BrowserGatewayBackgroundSummary"],
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
        "src/browser-gateway/webview/relay/relaySnapshotProjection.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway transcript-window compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayTranscriptWindow } from "@agentlink/protocol/browser-gateway-transcript-window";',
    ],
    sourceNotMatching: [
      /export\s+interface\s+BrowserGatewayTranscriptWindow\b/,
    ],
    extractedNames: ["BrowserGatewayTranscriptWindow"],
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
        "src/browser-gateway/testing/stateEquivalenceOracle.ts",
        "src/browser-gateway/webview/relay/RelayOwnerStore.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway transcript-message compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayTranscriptMessage } from "@agentlink/protocol/browser-gateway-transcript-message";',
    ],
    sourceNotMatching: [
      /export\s+interface\s+BrowserGatewayTranscriptMessage\b/,
    ],
    extractedNames: ["BrowserGatewayTranscriptMessage"],
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/OwnerTransport.ts",
        "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
        "src/browser-gateway/testing/phase3LiveParityGate.ts",
        "src/browser-gateway/testing/phase3ReliabilityGate.ts",
        "src/browser-gateway/testing/stateEquivalenceOracle.ts",
        "src/browser-gateway/webview/relay/RelayOwnerStore.ts",
        "src/browser-gateway/webview/relay/relaySnapshotProjection.test.ts",
        "src/browser-gateway/webview/relay/relaySnapshotProjection.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway transcript-block compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayTranscriptBlock } from "@agentlink/protocol/browser-gateway-transcript-block";',
    ],
    sourceNotMatching: [/export\s+type\s+BrowserGatewayTranscriptBlock\b\s*=/],
    extractedNames: ["BrowserGatewayTranscriptBlock"],
    importers: {
      baseline: ["src/browser-gateway/dataPlane/ownerProjectionAdapter.ts"],
    },
  },
  {
    title:
      "keeps browser-gateway transcript-text compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayTranscriptText } from "@agentlink/protocol/browser-gateway-transcript-text";',
    ],
    sourceNotMatching: [/export\s+type\s+BrowserGatewayTranscriptText\b\s*=/],
    extractedNames: ["BrowserGatewayTranscriptText"],
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
        "src/browser-gateway/testing/stateEquivalenceOracle.ts",
        "src/browser-gateway/webview/relay/relaySnapshotProjection.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway detached-session selection compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/BrowserGatewayService.ts",
    sourceContains: [
      'export type { BrowserGatewayDetachedSessionSelection } from "@agentlink/protocol/browser-gateway-detached-session-selection";',
    ],
    sourceNotMatching: [
      /export\s+(?:interface|type)\s+BrowserGatewayDetachedSessionSelection\b(?:\s*=)?/,
    ],
    extractedNames: ["BrowserGatewayDetachedSessionSelection"],
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/BrowserGatewayOwnerCommandExecutor.ts",
        "src/browser-gateway/webview/sessionDetailTransport.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway diff-preview compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayDiffPreview } from "@agentlink/protocol/browser-gateway-diff-preview";',
    ],
    sourceNotMatching: [/export\s+interface\s+BrowserGatewayDiffPreview\b/],
    extractedNames: ["BrowserGatewayDiffPreview"],
    importers: {
      baseline: ["src/browser-gateway/dataPlane/ownerProjectionAdapter.ts"],
    },
  },
  {
    title:
      "keeps browser-gateway interaction-state compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayInteractionState } from "@agentlink/protocol/browser-gateway-interaction-state";',
    ],
    sourceNotMatching: [
      /export\s+interface\s+BrowserGatewayInteractionState\b/,
    ],
    extractedNames: ["BrowserGatewayInteractionState"],
    importers: {
      baseline: ["src/browser-gateway/dataPlane/ownerProjectionAdapter.ts"],
    },
  },
  {
    title:
      "keeps browser-gateway interaction-summary compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayInteractionSummary } from "@agentlink/protocol/browser-gateway-interaction-summary";',
    ],
    sourceNotMatching: [
      /export\s+interface\s+BrowserGatewayInteractionSummary\b/,
    ],
    extractedNames: ["BrowserGatewayInteractionSummary"],
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
        "src/browser-gateway/testing/stateEquivalenceOracle.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway owner-control metadata compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'from "@agentlink/protocol/browser-gateway-owner-control-metadata";',
    ],
    sourceNotMatching: [
      /export\s+const\s+BROWSER_GATEWAY_OWNER_CONTROL_KINDS\b/,
      /export\s+type\s+BrowserGateway(?:OwnerControlKind|RelayResetReason)\b/,
    ],
    extractedNames: [
      "BROWSER_GATEWAY_OWNER_CONTROL_KINDS",
      "BROWSER_GATEWAY_RELAY_RESET_REASONS",
      "BrowserGatewayOwnerControlKind",
      "BrowserGatewayRelayResetReason",
    ],
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/protocol.test.ts",
        "src/browser-gateway/helper/OwnerRelayStore.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway owner-event metadata compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'from "@agentlink/protocol/browser-gateway-owner-event-metadata";',
    ],
    sourceNotMatching: [
      /export\s+const\s+BROWSER_GATEWAY_OWNER_EVENT_KINDS\b/,
      /export\s+type\s+BrowserGatewayOwnerEventKind\b/,
    ],
    extractedNames: [
      "BROWSER_GATEWAY_OWNER_EVENT_KINDS",
      "BrowserGatewayOwnerEventKind",
    ],
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/OwnerTransport.ts",
        "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
        "src/browser-gateway/dataPlane/protocol.test.ts",
        "src/browser-gateway/testing/ownerDataPlaneLoadFixture.ts",
        "src/browser-gateway/testing/phase3MobileBrowserFixture.ts",
        "src/browser-gateway/webview/relay/useRelayGatewayConnection.test.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway operation-state compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      "type BrowserGatewayOperationState,",
      'from "@agentlink/protocol/browser-gateway-operation-state";',
    ],
    sourceNotMatching: [/export\s+interface\s+BrowserGatewayOperationState\b/],
    extractedNames: [
      "BROWSER_GATEWAY_OPERATION_STATUSES",
      "BrowserGatewayOperationState",
      "BrowserGatewayOperationStatus",
    ],
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.ts",
        "src/browser-gateway/helper/AskAgentOwnerAdapter.ts",
        "src/browser-gateway/helper/commandRoutes.test.ts",
        "src/browser-gateway/helper/commandRoutes.ts",
        "src/browser-gateway/helper/relayRoutes.ts",
        "src/browser-gateway/testing/stateEquivalenceOracle.ts",
        "src/browser-gateway/webview/relay/RelayConnectionManager.ts",
        "src/browser-gateway/webview/relay/RelayOwnerStore.ts",
        "src/browser-gateway/webview/relay/useRelayGatewayConnection.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway command-metadata compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'from "@agentlink/protocol/browser-gateway-owner-command-metadata";',
    ],
    sourceNotMatching: [
      /export\s+const\s+BROWSER_GATEWAY_OWNER_COMMAND_KINDS\b/,
      /export\s+const\s+BROWSER_GATEWAY_COMMAND_(?:DEADLINE_CLASSES|IDEMPOTENCIES|IDEMPOTENCY)\b/,
    ],
    extractedNames: [
      "BROWSER_GATEWAY_COMMAND_DEADLINE_CLASSES",
      "BROWSER_GATEWAY_COMMAND_IDEMPOTENCIES",
      "BROWSER_GATEWAY_COMMAND_IDEMPOTENCY",
      "BROWSER_GATEWAY_OWNER_COMMAND_KINDS",
      "BrowserGatewayCommandDeadlineClass",
      "BrowserGatewayCommandIdempotency",
      "BrowserGatewayOwnerCommandKind",
    ],
    importers: {
      baseline: [
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
      ],
    },
  },
  {
    title:
      "keeps browser-gateway todo-item compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayTodoItem } from "@agentlink/protocol/browser-gateway-todo-item";',
    ],
    sourceNotMatching: [/export\s+interface\s+BrowserGatewayTodoItem\b/],
    extractedNames: ["BrowserGatewayTodoItem"],
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
        "src/browser-gateway/testing/stateEquivalenceOracle.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway queue-item compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayQueueItem } from "@agentlink/protocol/browser-gateway-queue-item";',
    ],
    sourceNotMatching: [/export\s+interface\s+BrowserGatewayQueueItem\b/],
    extractedNames: ["BrowserGatewayQueueItem"],
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
        "src/browser-gateway/testing/stateEquivalenceOracle.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway repository-state compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayRepositoryState } from "@agentlink/protocol/browser-gateway-repository-state";',
    ],
    sourceNotMatching: [/export\s+interface\s+BrowserGatewayRepositoryState\b/],
    extractedNames: ["BrowserGatewayRepositoryState"],
    importers: {
      baseline: ["src/browser-gateway/dataPlane/ownerProjectionAdapter.ts"],
    },
  },
  {
    title:
      "keeps browser-gateway context-budget compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayContextBudget } from "@agentlink/protocol/browser-gateway-context-budget";',
    ],
    sourceNotMatching: [/export\s+interface\s+BrowserGatewayContextBudget\b/],
    extractedNames: ["BrowserGatewayContextBudget"],
    importers: {
      baseline: ["src/browser-gateway/testing/stateEquivalenceOracle.ts"],
    },
  },
  {
    title:
      "keeps browser-gateway protocol-error compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'from "@agentlink/protocol/browser-gateway-protocol-error";',
    ],
    extractedNames: [
      "BrowserGatewayProtocolError",
      "BrowserGatewayProtocolErrorCode",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("class|interface|type"),
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/ownerProjectionAdapter.test.ts",
        "src/browser-gateway/dataPlane/protocol.test.ts",
        "src/browser-gateway/helper/commandRoutes.ts",
        "src/browser-gateway/helper/dataPlaneRoutes.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway owner-publication batch compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayOwnerPublicationBatch } from "@agentlink/protocol/browser-gateway-owner-publication-batch";',
    ],
    sourceNotMatching: [
      /export\s+(?:interface|type)\s+BrowserGatewayOwnerPublicationBatch\b(?:\s*=)?/,
    ],
    extractedNames: ["BrowserGatewayOwnerPublicationBatch"],
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/OwnerTransport.test.ts",
        "src/browser-gateway/dataPlane/OwnerTransport.ts",
        "src/browser-gateway/helper/AskAgentOwnerAdapter.test.ts",
        "src/browser-gateway/helper/AskAgentOwnerAdapter.ts",
        "src/browser-gateway/helper/OwnerRelayStore.test.ts",
        "src/browser-gateway/helper/dataPlaneRoutes.test.ts",
        "src/browser-gateway/helper/dataPlaneRoutes.ts",
        "src/browser-gateway/helper/dataPlaneRoutes.unit.test.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway owner-checkpoint compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayOwnerCheckpoint } from "@agentlink/protocol/browser-gateway-owner-checkpoint";',
    ],
    sourceNotMatching: [
      /export\s+(?:interface|type)\s+BrowserGatewayOwnerCheckpoint\b(?:\s*=)?/,
    ],
    extractedNames: ["BrowserGatewayOwnerCheckpoint"],
    importers: {
      baseline: [
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
      ],
    },
  },
  {
    title:
      "keeps browser-gateway owner-event compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: ['from "@agentlink/protocol/browser-gateway-owner-event";'],
    extractedNames: [
      "BrowserGatewayOwnerEvent",
      "BrowserGatewayOwnerEventPayload",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: {
      baseline: [
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
      ],
    },
  },
  {
    title:
      "keeps browser-gateway owner-control compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayOwnerControl } from "@agentlink/protocol/browser-gateway-owner-control";',
    ],
    sourceNotMatching: [
      /export\s+(?:interface|type)\s+BrowserGatewayOwnerControl\b(?:\s*=)?/,
    ],
    extractedNames: ["BrowserGatewayOwnerControl"],
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.test.ts",
        "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.ts",
        "src/browser-gateway/dataPlane/OwnerTransport.ts",
        "src/browser-gateway/helper/dataPlaneRoutes.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway owner-command acknowledgement compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayOwnerCommandAck } from "@agentlink/protocol/browser-gateway-owner-command-ack";',
    ],
    sourceNotMatching: [
      /export\s+(?:interface|type)\s+BrowserGatewayOwnerCommandAck\b(?:\s*=)?/,
    ],
    extractedNames: ["BrowserGatewayOwnerCommandAck"],
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.test.ts",
        "src/browser-gateway/dataPlane/OwnerTransport.ts",
        "src/browser-gateway/helper/commandRoutes.test.ts",
        "src/browser-gateway/helper/commandRoutes.ts",
        "src/browser-gateway/helper/dataPlaneRoutes.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway owner-command compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayOwnerCommand } from "@agentlink/protocol/browser-gateway-owner-command";',
    ],
    sourceNotMatching: [/export\s+interface\s+BrowserGatewayOwnerCommand\b/],
    extractedNames: ["BrowserGatewayOwnerCommand"],
    importers: {
      baseline: [
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
      ],
    },
  },
  {
    title:
      "keeps browser-gateway owner-command body compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export type { BrowserGatewayOwnerCommandBody } from "@agentlink/protocol/browser-gateway-owner-command-body";',
    ],
    sourceNotMatching: [
      /export\s+type\s+BrowserGatewayOwnerCommandBody\b(?:\s*=)?/,
    ],
    extractedNames: ["BrowserGatewayOwnerCommandBody"],
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/BrowserGatewayOwnerCommandExecutor.ts",
        "src/browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.ts",
        "src/browser-gateway/helper/AskAgentOwnerAdapter.test.ts",
        "src/browser-gateway/helper/commandRoutes.test.ts",
        "src/browser-gateway/helper/commandRoutes.ts",
        "src/browser-gateway/webview/relay/RelayConnectionManager.ts",
        "src/browser-gateway/webview/relay/useRelayGatewayConnection.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway foreground-control compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'from "@agentlink/protocol/browser-gateway-foreground-control-state";',
    ],
    extractedNames: [
      "BrowserGatewayForegroundControlState",
      "BrowserGatewayRevertRecoveryNotice",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
        "src/browser-gateway/testing/stateEquivalenceOracle.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway session-catalog compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'from "@agentlink/protocol/browser-gateway-session-catalog";',
    ],
    extractedNames: [
      "BrowserGatewayProjectSummary",
      "BrowserGatewaySessionSummary",
      "BrowserGatewaySessionCatalog",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
        "src/browser-gateway/testing/stateEquivalenceOracle.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway chat-workspace summary compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'from "@agentlink/protocol/browser-gateway-chat-workspace-summary";',
    ],
    extractedNames: [
      "BrowserGatewayChatTabStatus",
      "BrowserGatewayChatTabSummary",
      "BrowserGatewayChatWorkspaceSummary",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: {
      baseline: [
        "src/browser-gateway/BrowserGatewayService.ts",
        "src/browser-gateway/webview/BrowserGatewayApp.test.ts",
        "src/browser-gateway/webview/BrowserGatewayApp.tsx",
      ],
    },
  },
  {
    title: PHASE_A2_FACADES_TITLE,
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'from "@agentlink/protocol/browser-gateway-data-plane-transport";',
    ],
    extractedNames: [
      "BrowserGatewayChatTabSelection",
      "BrowserGatewayOwnerRegistration",
      "BrowserGatewayRelayReset",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: { baseline: ["src/browser-gateway/dataPlane/protocol.test.ts"] },
  },
  {
    title: PHASE_A2_FACADES_TITLE,
    compatibilityPath: "src/browser-gateway/dataPlane/interactionPayload.ts",
    sourceContains: [
      'from "@agentlink/protocol/browser-gateway-owner-interaction-payload";',
    ],
    extractedNames: [
      "BrowserGatewayOwnerInteractionPayload",
      "BrowserGatewayOwnerQuestionProgressPayload",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: {
      baseline: [
        "src/browser-gateway/dataPlane/ownerProjectionAdapter.test.ts",
        "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
        "src/browser-gateway/dataPlane/ownerProjectionSources.ts",
        "src/browser-gateway/helper/AskAgentOwnerAdapter.ts",
        "src/browser-gateway/webview/relay/relaySnapshotProjection.test.ts",
        "src/browser-gateway/webview/relay/relaySnapshotProjection.ts",
        "src/browser-gateway/webview/relay/useRelayGatewayConnection.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway data-plane version compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      'export { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "@agentlink/protocol/browser-gateway-data-plane-version";',
    ],
    sourceNotMatching: [
      /export\s+const\s+BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION\b/,
    ],
    extractedNames: ["BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION"],
    importers: {
      baseline: [
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
      ],
    },
  },
  {
    title:
      "keeps browser-gateway data-plane identity compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/protocol.ts",
    sourceContains: [
      [
        "export type {",
        "  BrowserGatewayDataPlaneIdentity,",
        "  BrowserGatewayDetailHandle,",
        '} from "@agentlink/protocol/browser-gateway-data-plane-identity";',
      ].join("\n"),
    ],
    extractedNames: [
      "BrowserGatewayDataPlaneIdentity",
      "BrowserGatewayDetailHandle",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: {
      baseline: [
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
      ],
    },
  },
  {
    title:
      "keeps browser-gateway instance-status compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/protocol.ts",
    sourceContains: [
      [
        "export type {",
        "  BrowserGatewayInstanceStatusKind,",
        "  BrowserGatewayInstanceStatusSummary,",
        '} from "@agentlink/protocol/browser-gateway-instance-status";',
      ].join("\n"),
    ],
    extractedNames: [
      "BrowserGatewayInstanceStatusKind",
      "BrowserGatewayInstanceStatusSummary",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: {
      baseline: [
        "src/browser-gateway/BrowserGatewayServer.ts",
        "src/browser-gateway/BrowserGatewayService.ts",
        "src/browser-gateway/helper/browserGatewayHelper.ts",
        "src/browser-gateway/webview/BrowserGatewayApp.tsx",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway model-provider identity compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/browserGatewayModelProviderIds.ts",
    sourceIs:
      'export * from "@agentlink/protocol/browser-gateway-model-provider-identity";\n',
    importers: {
      baseline: [
        "src/browser-gateway/browserGatewayAskAgentSessionStore.ts",
        "src/browser-gateway/browserGatewayModelAuthLeaseStore.ts",
        "src/browser-gateway/browserGatewayModelCredentialCache.ts",
        "src/browser-gateway/helper/askAgentModelClient.ts",
        "src/browser-gateway/helper/browserGatewayHelper.ts",
        "src/extension.ts",
      ],
    },
  },
  {
    title:
      "keeps browser-gateway data-plane limits compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/dataPlane/limits.ts",
    sourceIs:
      'export * from "@agentlink/protocol/browser-gateway-data-plane-limits";\n',
    importers: {
      baseline: [
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
      ],
    },
  },
  {
    title:
      "keeps browser-gateway data-plane mode compatibility package-owned with bounded importers",
    compatibilityPath: "src/browser-gateway/browserGatewayDataPlaneMode.ts",
    sourceIs:
      'export * from "@agentlink/protocol/browser-gateway-data-plane-mode";\n',
    importers: {
      baseline: [
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
      ],
    },
  },
  {
    title: "keeps surface-model-message compatibility package-owned and unused",
    compatibilityPath: "src/core/surfaceModelMessages.ts",
    sourceIs: 'export * from "@agentlink/core/surface-model-messages";\n',
    packageSource: {
      path: "packages/core/src/surfaceModelMessages.ts",
      contains: [
        [
          "export type {",
          "  CoreSurfaceModelMediaItem,",
          "  CoreSurfaceModelMessage,",
          "  CoreSurfaceQuestionAnswerItem,",
          '} from "@agentlink/protocol/surface-model-message";',
        ].join("\n"),
      ],
    },
    extractedNames: [
      "CoreSurfaceModelMediaItem",
      "CoreSurfaceModelMessage",
      "CoreSurfaceQuestionAnswerItem",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: "unused",
  },
  {
    title: TERMINAL_SECURITY_FACADES_TITLE,
    compatibilityPath: "src/core/capabilities/terminal.ts",
    sourceContains: ['} from "@agentlink/protocol/terminal-security";'],
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
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: "unused",
  },
  {
    title: TERMINAL_SECURITY_FACADES_TITLE,
    compatibilityPath: "src/core/sandboxPolicy.ts",
    sourceContains: ['} from "@agentlink/protocol/terminal-security";'],
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
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: "unused",
  },
  {
    title: TERMINAL_SURFACE_FACADES_TITLE,
    compatibilityPath: "src/terminal/terminalSurfaceProtocol.ts",
    sourceIs: 'export * from "@agentlink/protocol/terminal-surface";\n',
    importers: {
      baseline: [
        "src/terminal/HostTerminalSurfaceController.ts",
        "src/terminal/LiveHostTerminalSurfaceController.ts",
        "src/terminal/terminalSurfaceProtocol.test.ts",
        "src/terminal/webview/terminalWebviewController.test.ts",
        "src/terminal/webview/terminalWebviewController.ts",
      ],
    },
  },
  {
    title: TERMINAL_SURFACE_FACADES_TITLE,
    compatibilityPath: "src/terminal/alternateScreenTracker.ts",
    sourceContains: [
      'export type { AlternateScreenTransition } from "@agentlink/protocol/terminal-surface";',
    ],
    extractedNames: ["AlternateScreenTransition"],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: "unused",
  },
  {
    title: TERMINAL_SURFACE_FACADES_TITLE,
    compatibilityPath: "src/terminal/hostTerminalBlocks.ts",
    sourceContains: ['} from "@agentlink/protocol/terminal-surface";'],
    extractedNames: [
      "HostTerminalBlock",
      "HostTerminalBlockState",
      "HostTerminalCommandBlock",
      "HostTerminalPromptBlock",
      "HostTerminalRawBlock",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: "unused",
  },
  {
    title: TERMINAL_SURFACE_FACADES_TITLE,
    compatibilityPath: "src/terminal/terminalOutputPolicy.ts",
    sourceContains: ['} from "@agentlink/protocol/terminal-surface";'],
    extractedNames: [
      "TerminalOutputPolicyAction",
      "TerminalOutputPolicyDecision",
      "TerminalOutputPolicyReason",
    ],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: "unused",
  },
  {
    title: TERMINAL_SURFACE_FACADES_TITLE,
    compatibilityPath: "src/terminal/shellIntegration.ts",
    sourceContains: [
      'export type { ShellIntegrationMode } from "@agentlink/protocol/terminal-surface";',
    ],
    extractedNames: ["ShellIntegrationMode"],
    forbiddenLocalDeclaration: exportedDeclaration("interface|type"),
    importers: "unused",
  },
];

describe("protocol package boundary", () => {
  it("keeps production protocol modules browser-safe and independent from root source", async () => {
    const violations: string[] = [];

    for (const filePath of walkTypeScriptFiles(PROTOCOL_SOURCE)) {
      if (filePath.endsWith(".test.ts")) continue;
      const source = readSourceText(filePath);
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

  // One test per title in PROTOCOL_MODULE_WIRINGS. Rows that share a title
  // are modules the same test has always covered together.
  for (const [title, wirings] of groupRowsByTitle(
    PROTOCOL_MODULE_WIRINGS,
    protocolModuleWiringTitle,
  )) {
    it(title, () => {
      for (const wiring of wirings) checkProtocolModuleWiring(wiring);
    });
  }

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
        const source = readSourceText(filePath);
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
      const source = readSourceText(filePath);
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
      const source = readSourceText(filePath);
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
    // The repository contracts are owned by the portable core package.
    expect(contractsSource).toContain('} from "@agentlink/core/memory";');
    expect(
      fs.readFileSync(
        path.join(ROOT, "packages/core/src/memory/contracts.ts"),
        "utf8",
      ),
    ).toContain("export interface MemoryRepository");
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
      const source = readSourceText(filePath);
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
      const source = readSourceText(filePath);
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
      const source = readSourceText(filePath);
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
      const source = readSourceText(filePath);
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
      const source = readSourceText(filePath);
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
      const source = readSourceText(filePath);
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

  // One test per title in COMPATIBILITY_FACADES. Rows that share a title are
  // facades the same test has always covered together.
  for (const [title, facades] of groupRowsByTitle(
    COMPATIBILITY_FACADES,
    (facade) => facade.title,
  )) {
    it(title, () => {
      for (const facade of facades) checkCompatibilityFacade(facade);
    });
  }

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
      const source = readSourceText(filePath);
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
      const source = readSourceText(filePath);
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
      const source = readSourceText(filePath);
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
      const source = readSourceText(filePath);
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
      const source = readSourceText(filePath);
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
      const source = readSourceText(filePath);
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
      const source = readSourceText(filePath);
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
      const source = readSourceText(filePath);
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
        source: readSourceText(filePath),
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
  // Every specifier that resolves to the module ends with its file name, so a
  // file that never mentions the name cannot import it. Skipping those files
  // avoids running five regular expressions over the whole source tree.
  const compatibilityModuleName = path.basename(compatibilityModule);

  for (const { filePath, source } of options.sourceFiles) {
    if (
      filePath === options.compatibilityPath ||
      filePath === path.join(ROOT, "src/protocolPackageBoundary.test.ts") ||
      !source.includes(compatibilityModuleName)
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

function groupRowsByTitle<Row>(
  rows: readonly Row[],
  titleOf: (row: Row) => string,
): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const title = titleOf(row);
    const group = groups.get(title);
    if (group) group.push(row);
    else groups.set(title, [row]);
  }
  return groups;
}

function protocolModuleWiringTitle(wiring: ProtocolModuleWiring): string {
  return (
    wiring.title ??
    `wires ${wiring.exportPath} through every public package build surface`
  );
}

function checkProtocolModuleWiring(wiring: ProtocolModuleWiring): void {
  const { exportPath, fileName } = wiring;
  const packageDirectory = path.join(ROOT, "packages", "protocol");
  const requireSubpath = (): unknown =>
    requireFromBoundaryTest(`@agentlink/protocol/${exportPath}`);
  const requireRoot = (): unknown =>
    requireFromBoundaryTest("@agentlink/protocol");

  const packageManifest = JSON.parse(
    readSourceText(path.join(packageDirectory, "package.json")),
  ) as { exports?: Record<string, unknown> };
  if (wiring.manifest === "present") {
    expect(packageManifest.exports).toHaveProperty(`./${exportPath}`);
  } else {
    expect(packageManifest.exports?.[`./${exportPath}`]).toEqual({
      browser: {
        types: `./dist/${fileName}.d.ts`,
        default: `./dist/${fileName}.js`,
      },
      import: {
        types: `./dist/${fileName}.d.ts`,
        default: `./dist/${fileName}.js`,
      },
      require: {
        types: `./dist/cjs/${fileName}.d.cts`,
        default: `./dist/cjs/${fileName}.cjs`,
      },
    });
  }

  const indexSource = readSourceText(path.join(PROTOCOL_SOURCE, "index.ts"));
  if (wiring.index === "root") {
    expect(indexSource).toContain(`export * from "./${fileName}.js";`);
  } else {
    expect(indexSource).toContain(`\`${fileName}\` is subpath-only`);
    expect(indexSource).not.toContain(`export * from "./${fileName}.js";`);
  }

  for (const buildScript of ["build-cjs.mjs", "watch.mjs"]) {
    const source = readSourceText(path.join(packageDirectory, buildScript));
    expect(source, buildScript).toContain(`"src/${fileName}.ts"`);
    if (wiring.readsEsmDeclaration) {
      expect(source, buildScript).toContain(
        `readFile("dist/${fileName}.d.ts", "utf8")`,
      );
    }
    if (wiring.declarationOutput !== false) {
      expect(source, buildScript).toContain(`"dist/cjs/${fileName}.d.cts"`);
    }
    switch (wiring.cjsRootReexport) {
      case "export-star":
        // The scripts write the CJS index from a string literal, so the
        // expected text ends in a backslash followed by "n", not a newline.
        expect(source, buildScript).toContain(
          `export * from "./${fileName}.cjs";\\n`,
        );
        break;
      case "quoted-specifier":
        expect(source, buildScript).toContain(`"./${fileName}.cjs"`);
        break;
      case "no-export-star":
        expect(source, buildScript).not.toContain(
          `export * from "./${fileName}.cjs";`,
        );
        break;
      case "no-quoted-specifier":
        expect(source, buildScript).not.toContain(`"./${fileName}.cjs"`);
        break;
      case "unchecked":
        break;
    }
    for (const text of wiring.buildScriptContains ?? []) {
      expect(source, `${buildScript}:${text}`).toContain(text);
    }
    const normalizedSource = source.replace(/\s+/g, " ");
    for (const dependency of wiring.rewrittenDependencies ?? []) {
      expect(normalizedSource, `${buildScript}:${dependency}`).toMatch(
        new RegExp(
          `\\.replaceAll\\(\\s*'"\\.\\/${dependency}\\.js"'\\s*,\\s*'"\\.\\/${dependency}\\.cjs"'\\s*,?\\s*\\)`,
        ),
      );
    }
    for (const pattern of wiring.normalizedBuildScriptMatches ?? []) {
      expect(normalizedSource, buildScript).toMatch(pattern);
    }
  }

  const cjsDirectory = path.join(packageDirectory, "dist", "cjs");
  for (const check of wiring.dist ?? []) {
    switch (check) {
      case "rootDeclaration":
        expect(
          readSourceText(path.join(cjsDirectory, "index.d.cts")),
        ).toContain(`export * from "./${fileName}.cjs";`);
        break;
      case "cjsFile":
        expect(fs.existsSync(path.join(cjsDirectory, `${fileName}.cjs`))).toBe(
          true,
        );
        break;
      case "rootCjsFile":
        expect(fs.existsSync(path.join(cjsDirectory, "index.cjs"))).toBe(true);
        break;
      case "requireRoot":
        expect(() => requireRoot()).not.toThrow();
        break;
      case "requireSubpath":
        expect(() => requireSubpath()).not.toThrow();
        break;
    }
  }

  const declarationTexts = [
    ...(wiring.rewrittenDependencies ?? []).map(
      (dependency) => `from "./${dependency}.cjs";`,
    ),
    ...(wiring.declarationContains ?? []),
  ];
  if (declarationTexts.length > 0) {
    const declaration = readSourceText(
      path.join(cjsDirectory, `${fileName}.d.cts`),
    );
    for (const text of declarationTexts) {
      expect(declaration, `${fileName}.d.cts`).toContain(text);
    }
  }

  if (wiring.runtimeLists) {
    const runtimeModule = requireSubpath() as Record<string, unknown>;
    for (const list of wiring.runtimeLists) {
      const actual = runtimeModule[list.name];
      expect(actual, list.name).toEqual(list.values);
      expect(Object.isFrozen(actual), list.name).toBe(list.frozen);
      if (list.frozen) {
        expect(() => (actual as string[]).push("other"), list.name).toThrow(
          TypeError,
        );
      }
    }
  }

  wiring.extra?.({ wiring, requireSubpath, requireRoot });
}

function checkBrowserGatewayProtocolErrorRuntime(
  context: ProtocolModuleWiringContext,
): void {
  type ProtocolErrorConstructor = new (
    code: "invalid_value",
    path: string,
    message: string,
  ) => Error & { code: string; path: string };
  const protocolErrorModule = context.requireSubpath() as {
    BrowserGatewayProtocolError: ProtocolErrorConstructor;
  };
  const rootProtocolModule = context.requireRoot() as {
    BrowserGatewayProtocolError: ProtocolErrorConstructor;
  };
  for (const constructor of [
    protocolErrorModule.BrowserGatewayProtocolError,
    rootProtocolModule.BrowserGatewayProtocolError,
  ]) {
    const error = new constructor("invalid_value", "$.field", "must be valid");
    expect(error).toBeInstanceOf(constructor);
    expect(error).toMatchObject({
      name: "BrowserGatewayProtocolError",
      code: "invalid_value",
      path: "$.field",
      message: "$.field: must be valid",
    });
  }
}

function checkBrowserGatewayDataPlaneVersionRuntime(
  context: ProtocolModuleWiringContext,
): void {
  const versionModule = context.requireSubpath() as {
    BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION?: string;
  };
  expect(versionModule.BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION).toBe("1");
}

function exportedDeclaration(kinds: string): (extractedName: string) => RegExp {
  return (extractedName) =>
    new RegExp(`export\\s+(?:${kinds})\\s+${extractedName}\\b(?:\\s*=)?`);
}

function exportedInterfaceDeclaration(extractedName: string): RegExp {
  return new RegExp(`export\\s+interface\\s+${extractedName}\\b`);
}

function checkCompatibilityFacade(facade: CompatibilityFacade): void {
  const compatibilityPath = path.join(ROOT, facade.compatibilityPath);
  const compatibilitySource = readSourceText(compatibilityPath);
  if (facade.sourceIs !== undefined) {
    expect(compatibilitySource, facade.compatibilityPath).toBe(facade.sourceIs);
  }
  for (const text of facade.sourceContains ?? []) {
    expect(compatibilitySource, facade.compatibilityPath).toContain(text);
  }
  if (facade.packageSource) {
    const packageSource = readSourceText(
      path.join(ROOT, facade.packageSource.path),
    );
    for (const text of facade.packageSource.contains) {
      expect(packageSource, facade.packageSource.path).toContain(text);
    }
  }
  for (const pattern of facade.sourceNotMatching ?? []) {
    expect(compatibilitySource, facade.compatibilityPath).not.toMatch(pattern);
  }
  if (facade.forbiddenLocalDeclaration) {
    for (const extractedName of facade.extractedNames ?? []) {
      expect(
        compatibilitySource,
        `${facade.compatibilityPath}:${extractedName}`,
      ).not.toMatch(facade.forbiddenLocalDeclaration(extractedName));
    }
  }

  const sourceFiles = walkTypeScriptFiles(path.join(ROOT, "src")).map(
    (filePath) => ({ filePath, source: readSourceText(filePath) }),
  );
  const importers = findCompatibilityImporters({
    compatibilityPath,
    sourceFiles,
    extractedNames: facade.extractedNames,
  });
  if (facade.importers === "unused") {
    expect(importers, facade.compatibilityPath).toEqual([]);
    return;
  }
  const importerBaseline = new Set<string>(facade.importers.baseline);
  // Compatibility imports may decrease during A4, but new importers are forbidden.
  expect(
    importers.every((importer) => importerBaseline.has(importer)),
    `${facade.compatibilityPath} importers: ${importers.join(", ")}`,
  ).toBe(true);
  expect(importers.length, facade.compatibilityPath).toBeLessThanOrEqual(
    importerBaseline.size,
  );
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

// Many tests scan the same source trees. Nothing here writes to them, so each
// directory is listed and each file read once per run instead of once per test.
const walkedDirectories = new Map<string, readonly string[]>();
const sourceTexts = new Map<string, string>();

function readSourceText(filePath: string): string {
  let text = sourceTexts.get(filePath);
  if (text === undefined) {
    text = fs.readFileSync(filePath, "utf8");
    sourceTexts.set(filePath, text);
  }
  return text;
}

function walkTypeScriptFiles(directory: string): string[] {
  let files = walkedDirectories.get(directory);
  if (!files) {
    files = listTypeScriptFiles(directory);
    walkedDirectories.set(directory, files);
  }
  return [...files];
}

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(candidate));
    else if (entry.isFile() && /\.tsx?$/.test(candidate)) files.push(candidate);
  }
  return files.sort();
}
