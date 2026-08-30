import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

import { build } from "esbuild";

await build({
  entryPoints: [
    "src/index.ts",
    "src/agentErrorPresentation.ts",
    "src/autoContinueProgress.ts",
    "src/autonomousMemory.ts",
    "src/backgroundResult.ts",
    "src/browserGatewayTheme.ts",
    "src/builtinCommandForwarding.ts",
    "src/chatCatalog.ts",
    "src/chatPaneTransport.ts",
    "src/chatSessionHistory.ts",
    "src/chatState.ts",
    "src/chatTranscript.ts",
    "src/chatWorkspace.ts",
    "src/commandApprovalPolicy.ts",
    "src/contextDiagnostics.ts",
    "src/contextHealth.ts",
    "src/contextLedger.ts",
    "src/session.ts",
    "src/sessionHandoffDraft.ts",
    "src/structuredQuestion.ts",
    "src/compose.ts",
    "src/agentPluginManager.ts",
    "src/diffSnapshot.ts",
    "src/finalStatus.ts",
    "src/findReplacePreview.ts",
    "src/fleetResult.ts",
    "src/inlineApproval.ts",
    "src/jsonc.ts",
    "src/mcpConfigImport.ts",
    "src/mcpConfigValidation.ts",
    "src/mcpElicitation.ts",
    "src/mcpManager.ts",
    "src/mcpToolIdentity.ts",
    "src/mcpUrlElicitation.ts",
    "src/modelAuth.ts",
    "src/modelCatalog.ts",
    "src/modelSetup.ts",
    "src/promptProfile.ts",
    "src/questionConfirmation.ts",
    "src/questionDetection.ts",
    "src/selectionCommands.ts",
    "src/semanticReadiness.ts",
    "src/sessionHydration.ts",
    "src/sidebarTransport.ts",
    "src/terminal.ts",
    "src/terminalSurface.ts",
    "src/todoContinuation.ts",
    "src/toolResult.ts",
    "src/workspaceProject.ts",
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir: "dist/cjs",
  outExtension: { ".js": ".cjs" },
  sourcemap: true,
});

await mkdir("dist/cjs", { recursive: true });
await Promise.all([
  writeFile(
    "dist/cjs/index.d.cts",
    'export * from "./agentErrorPresentation.cjs";\nexport * from "./agentPluginManager.cjs";\nexport * from "./autoContinueProgress.cjs";\nexport * from "./backgroundResult.cjs";\nexport * from "./browserGatewayTheme.cjs";\nexport * from "./builtinCommandForwarding.cjs";\nexport * from "./chatCatalog.cjs";\nexport * from "./chatPaneTransport.cjs";\nexport * from "./chatSessionHistory.cjs";\nexport * from "./chatState.cjs";\nexport * from "./chatTranscript.cjs";\nexport * from "./chatWorkspace.cjs";\nexport * from "./commandApprovalPolicy.cjs";\nexport * from "./compose.cjs";\nexport * from "./contextDiagnostics.cjs";\nexport * from "./contextHealth.cjs";\nexport * from "./contextLedger.cjs";\nexport * from "./diffSnapshot.cjs";\nexport * from "./finalStatus.cjs";\nexport * from "./fleetResult.cjs";\nexport * from "./inlineApproval.cjs";\nexport * from "./jsonc.cjs";\nexport * from "./mcpConfigImport.cjs";\nexport * from "./mcpConfigValidation.cjs";\nexport * from "./mcpElicitation.cjs";\nexport * from "./mcpManager.cjs";\nexport * from "./mcpToolIdentity.cjs";\nexport * from "./mcpUrlElicitation.cjs";\nexport * from "./modelAuth.cjs";\nexport * from "./modelCatalog.cjs";\nexport * from "./modelSetup.cjs";\nexport * from "./promptProfile.cjs";\nexport * from "./questionConfirmation.cjs";\nexport * from "./questionDetection.cjs";\nexport * from "./selectionCommands.cjs";\nexport * from "./semanticReadiness.cjs";\nexport * from "./session.cjs";\nexport * from "./sessionHandoffDraft.cjs";\nexport * from "./structuredQuestion.cjs";\nexport * from "./sessionHydration.cjs";\nexport * from "./terminal.cjs";\nexport * from "./terminalSurface.cjs";\nexport * from "./todoContinuation.cjs";\nexport * from "./toolResult.cjs";\nexport * from "./workspaceProject.cjs";\n',
  ),
  copyFile(
    "dist/agentErrorPresentation.d.ts",
    "dist/cjs/agentErrorPresentation.d.cts",
  ),
  copyFile("dist/session.d.ts", "dist/cjs/session.d.cts"),
  copyFile(
    "dist/sessionHandoffDraft.d.ts",
    "dist/cjs/sessionHandoffDraft.d.cts",
  ),
  copyFile("dist/structuredQuestion.d.ts", "dist/cjs/structuredQuestion.d.cts"),
  copyFile(
    "dist/autoContinueProgress.d.ts",
    "dist/cjs/autoContinueProgress.d.cts",
  ),
  copyFile("dist/autonomousMemory.d.ts", "dist/cjs/autonomousMemory.d.cts"),
  readFile("dist/backgroundResult.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/backgroundResult.d.cts",
      content
        .replaceAll('"./fleetResult.js"', '"./fleetResult.cjs"')
        .replaceAll('"./modelCatalog.js"', '"./modelCatalog.cjs"'),
    ),
  ),
  copyFile(
    "dist/browserGatewayTheme.d.ts",
    "dist/cjs/browserGatewayTheme.d.cts",
  ),
  copyFile(
    "dist/builtinCommandForwarding.d.ts",
    "dist/cjs/builtinCommandForwarding.d.cts",
  ),
  readFile("dist/chatCatalog.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/chatCatalog.d.cts",
      content.replaceAll('"./modelCatalog.js"', '"./modelCatalog.cjs"'),
    ),
  ),
  copyFile("dist/chatPaneTransport.d.ts", "dist/cjs/chatPaneTransport.d.cts"),
  readFile("dist/chatSessionHistory.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/chatSessionHistory.d.cts",
      content.replaceAll('"./chatCatalog.js"', '"./chatCatalog.cjs"'),
    ),
  ),
  readFile("dist/chatState.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/chatState.d.cts",
      content
        .replaceAll('"./chatCatalog.js"', '"./chatCatalog.cjs"')
        .replaceAll(
          '"./commandApprovalPolicy.js"',
          '"./commandApprovalPolicy.cjs"',
        )
        .replaceAll('"./contextHealth.js"', '"./contextHealth.cjs"')
        .replaceAll('"./sessionHydration.js"', '"./sessionHydration.cjs"')
        .replaceAll('"./terminal.js"', '"./terminal.cjs"'),
    ),
  ),
  readFile("dist/chatTranscript.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/chatTranscript.d.cts",
      content
        .replaceAll('"./backgroundResult.js"', '"./backgroundResult.cjs"')
        .replaceAll('"./chatCatalog.js"', '"./chatCatalog.cjs"')
        .replaceAll(
          '"./commandApprovalPolicy.js"',
          '"./commandApprovalPolicy.cjs"',
        )
        .replaceAll('"./compose.js"', '"./compose.cjs"')
        .replaceAll('"./contextDiagnostics.js"', '"./contextDiagnostics.cjs"')
        .replaceAll('"./finalStatus.js"', '"./finalStatus.cjs"')
        .replaceAll('"./toolResult.js"', '"./toolResult.cjs"'),
    ),
  ),
  copyFile("dist/chatWorkspace.d.ts", "dist/cjs/chatWorkspace.d.cts"),
  copyFile(
    "dist/commandApprovalPolicy.d.ts",
    "dist/cjs/commandApprovalPolicy.d.cts",
  ),
  copyFile("dist/compose.d.ts", "dist/cjs/compose.d.cts"),
  readFile("dist/contextDiagnostics.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/contextDiagnostics.d.cts",
      content
        .replaceAll('"./contextLedger.js"', '"./contextLedger.cjs"')
        .replaceAll('"./promptProfile.js"', '"./promptProfile.cjs"'),
    ),
  ),
  copyFile("dist/contextHealth.d.ts", "dist/cjs/contextHealth.d.cts"),
  copyFile("dist/contextLedger.d.ts", "dist/cjs/contextLedger.d.cts"),
  copyFile("dist/agentPluginManager.d.ts", "dist/cjs/agentPluginManager.d.cts"),
  copyFile("dist/diffSnapshot.d.ts", "dist/cjs/diffSnapshot.d.cts"),
  readFile("dist/finalStatus.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/finalStatus.d.cts",
      content.replaceAll('"./fleetResult.js"', '"./fleetResult.cjs"'),
    ),
  ),
  copyFile("dist/findReplacePreview.d.ts", "dist/cjs/findReplacePreview.d.cts"),
  copyFile("dist/fleetResult.d.ts", "dist/cjs/fleetResult.d.cts"),
  copyFile("dist/inlineApproval.d.ts", "dist/cjs/inlineApproval.d.cts"),
  copyFile("dist/jsonc.d.ts", "dist/cjs/jsonc.d.cts"),
  readFile("dist/mcpConfigImport.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/mcpConfigImport.d.cts",
      content.replaceAll(
        '"./mcpConfigValidation.js"',
        '"./mcpConfigValidation.cjs"',
      ),
    ),
  ),
  readFile("dist/mcpConfigValidation.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/mcpConfigValidation.d.cts",
      content.replaceAll('"./mcpManager.js"', '"./mcpManager.cjs"'),
    ),
  ),
  copyFile("dist/mcpElicitation.d.ts", "dist/cjs/mcpElicitation.d.cts"),
  copyFile("dist/mcpManager.d.ts", "dist/cjs/mcpManager.d.cts"),
  copyFile("dist/mcpToolIdentity.d.ts", "dist/cjs/mcpToolIdentity.d.cts"),
  copyFile("dist/mcpUrlElicitation.d.ts", "dist/cjs/mcpUrlElicitation.d.cts"),
  copyFile("dist/modelAuth.d.ts", "dist/cjs/modelAuth.d.cts"),
  copyFile("dist/modelCatalog.d.ts", "dist/cjs/modelCatalog.d.cts"),
  copyFile("dist/modelSetup.d.ts", "dist/cjs/modelSetup.d.cts"),
  copyFile("dist/promptProfile.d.ts", "dist/cjs/promptProfile.d.cts"),
  copyFile(
    "dist/questionConfirmation.d.ts",
    "dist/cjs/questionConfirmation.d.cts",
  ),
  copyFile("dist/questionDetection.d.ts", "dist/cjs/questionDetection.d.cts"),
  readFile("dist/selectionCommands.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/selectionCommands.d.cts",
      content
        .replaceAll(
          '"./commandApprovalPolicy.js"',
          '"./commandApprovalPolicy.cjs"',
        )
        .replaceAll('"./modelCatalog.js"', '"./modelCatalog.cjs"'),
    ),
  ),
  copyFile("dist/semanticReadiness.d.ts", "dist/cjs/semanticReadiness.d.cts"),
  readFile("dist/sessionHydration.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/sessionHydration.d.cts",
      content.replaceAll('"./backgroundResult.js"', '"./backgroundResult.cjs"'),
    ),
  ),
  readFile("dist/sidebarTransport.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/sidebarTransport.d.cts",
      content
        .replaceAll('"./contextHealth.js"', '"./contextHealth.cjs"')
        .replaceAll('"./semanticReadiness.js"', '"./semanticReadiness.cjs"'),
    ),
  ),
  copyFile("dist/terminal.d.ts", "dist/cjs/terminal.d.cts"),
  readFile("dist/terminalSurface.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/terminalSurface.d.cts",
      content.replaceAll('"./terminal.js"', '"./terminal.cjs"'),
    ),
  ),
  copyFile("dist/todoContinuation.d.ts", "dist/cjs/todoContinuation.d.cts"),
  readFile("dist/toolResult.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/toolResult.d.cts",
      content
        .replaceAll('"./compose.js"', '"./compose.cjs"')
        .replaceAll('"./mcpManager.js"', '"./mcpManager.cjs"'),
    ),
  ),
  copyFile("dist/workspaceProject.d.ts", "dist/cjs/workspaceProject.d.cts"),
]);
