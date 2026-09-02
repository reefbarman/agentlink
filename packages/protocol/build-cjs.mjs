import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

import { build } from "esbuild";

await build({
  entryPoints: [
    "src/index.ts",
    "src/agentErrorPresentation.ts",
    "src/approvalTransport.ts",
    "src/autoContinueProgress.ts",
    "src/autonomousMemory.ts",
    "src/backgroundResult.ts",
    "src/browserGatewayAskAgentIdentity.ts",
    "src/browserGatewayBackgroundSummary.ts",
    "src/browserGatewayCapabilityStatus.ts",
    "src/browserGatewayChatWorkspaceSummary.ts",
    "src/browserGatewayContextBudget.ts",
    "src/browserGatewayCoreOwnerRegistration.ts",
    "src/browserGatewayDataPlaneIdentity.ts",
    "src/browserGatewayDataPlaneLimits.ts",
    "src/browserGatewayDataPlaneMode.ts",
    "src/browserGatewayDataPlaneTransport.ts",
    "src/browserGatewayDataPlaneVersion.ts",
    "src/browserGatewayDetachedSessionSelection.ts",
    "src/browserGatewayDiffPreview.ts",
    "src/browserGatewayForegroundControlState.ts",
    "src/browserGatewayHelperLifecycle.ts",
    "src/browserGatewayInstanceStatus.ts",
    "src/browserGatewayInteractionState.ts",
    "src/browserGatewayInteractionSummary.ts",
    "src/browserGatewayModelProviderIdentity.ts",
    "src/browserGatewayOperationState.ts",
    "src/browserGatewayOwnerCheckpoint.ts",
    "src/browserGatewayOwnerCommand.ts",
    "src/browserGatewayOwnerCommandAck.ts",
    "src/browserGatewayOwnerCommandBody.ts",
    "src/browserGatewayOwnerCommandMetadata.ts",
    "src/browserGatewayOwnerControl.ts",
    "src/browserGatewayOwnerControlMetadata.ts",
    "src/browserGatewayOwnerEvent.ts",
    "src/browserGatewayOwnerEventMetadata.ts",
    "src/browserGatewayOwnerInteractionPayload.ts",
    "src/browserGatewayOwnerPublicationBatch.ts",
    "src/browserGatewayProtocolError.ts",
    "src/browserGatewayQueueItem.ts",
    "src/browserGatewayRepositoryState.ts",
    "src/browserGatewaySessionCatalog.ts",
    "src/browserGatewayTheme.ts",
    "src/browserGatewayTodoItem.ts",
    "src/browserGatewayTranscriptBlock.ts",
    "src/browserGatewayTranscriptMessage.ts",
    "src/browserGatewayTranscriptText.ts",
    "src/browserGatewayTranscriptWindow.ts",
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
    "src/providerReplay.ts",
    "src/questionConfirmation.ts",
    "src/questionDetection.ts",
    "src/retrievalDeletion.ts",
    "src/retrievalFingerprint.ts",
    "src/retrievalMaintenance.ts",
    "src/retrievalStructuralSnapshot.ts",
    "src/retrievalHealth.ts",
    "src/retrievalPublication.ts",
    "src/retrievalQuery.ts",
    "src/retrievalRecords.ts",
    "src/selectionCommands.ts",
    "src/semanticReadiness.ts",
    "src/sessionHydration.ts",
    "src/surfaceModelMessage.ts",
    "src/sidebarTransport.ts",
    "src/terminal.ts",
    "src/terminalSecurity.ts",
    "src/terminalSurface.ts",
    "src/todoContinuation.ts",
    "src/toolResult.ts",
    "src/webAccessPolicy.ts",
    "src/webActivity.ts",
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
    'export * from "./agentErrorPresentation.cjs";\nexport * from "./agentPluginManager.cjs";\nexport * from "./autoContinueProgress.cjs";\nexport * from "./backgroundResult.cjs";\nexport * from "./browserGatewayAskAgentIdentity.cjs";\nexport * from "./browserGatewayBackgroundSummary.cjs";\nexport * from "./browserGatewayCapabilityStatus.cjs";\nexport * from "./browserGatewayChatWorkspaceSummary.cjs";\nexport * from "./browserGatewayContextBudget.cjs";\nexport * from "./browserGatewayCoreOwnerRegistration.cjs";\nexport * from "./browserGatewayDataPlaneIdentity.cjs";\nexport * from "./browserGatewayDataPlaneLimits.cjs";\nexport * from "./browserGatewayDataPlaneMode.cjs";\nexport * from "./browserGatewayDataPlaneTransport.cjs";\nexport * from "./browserGatewayDataPlaneVersion.cjs";\nexport * from "./browserGatewayDetachedSessionSelection.cjs";\nexport * from "./browserGatewayDiffPreview.cjs";\nexport * from "./browserGatewayForegroundControlState.cjs";\nexport * from "./browserGatewayHelperLifecycle.cjs";\nexport * from "./browserGatewayInstanceStatus.cjs";\nexport * from "./browserGatewayInteractionState.cjs";\nexport * from "./browserGatewayInteractionSummary.cjs";\nexport * from "./browserGatewayModelProviderIdentity.cjs";\nexport * from "./browserGatewayOperationState.cjs";\nexport * from "./browserGatewayOwnerCheckpoint.cjs";\nexport * from "./browserGatewayOwnerCommand.cjs";\nexport * from "./browserGatewayOwnerCommandAck.cjs";\nexport * from "./browserGatewayOwnerCommandBody.cjs";\nexport * from "./browserGatewayOwnerCommandMetadata.cjs";\nexport * from "./browserGatewayOwnerControl.cjs";\nexport * from "./browserGatewayOwnerControlMetadata.cjs";\nexport * from "./browserGatewayOwnerEvent.cjs";\nexport * from "./browserGatewayOwnerEventMetadata.cjs";\nexport * from "./browserGatewayOwnerInteractionPayload.cjs";\nexport * from "./browserGatewayOwnerPublicationBatch.cjs";\nexport * from "./browserGatewayProtocolError.cjs";\nexport * from "./browserGatewayQueueItem.cjs";\nexport * from "./browserGatewayRepositoryState.cjs";\nexport * from "./browserGatewaySessionCatalog.cjs";\nexport * from "./browserGatewayTheme.cjs";\nexport * from "./browserGatewayTodoItem.cjs";\nexport * from "./browserGatewayTranscriptBlock.cjs";\nexport * from "./browserGatewayTranscriptMessage.cjs";\nexport * from "./browserGatewayTranscriptText.cjs";\nexport * from "./browserGatewayTranscriptWindow.cjs";\nexport * from "./builtinCommandForwarding.cjs";\nexport * from "./chatCatalog.cjs";\nexport * from "./chatPaneTransport.cjs";\nexport * from "./chatSessionHistory.cjs";\nexport * from "./chatState.cjs";\nexport * from "./chatTranscript.cjs";\nexport * from "./chatWorkspace.cjs";\nexport * from "./commandApprovalPolicy.cjs";\nexport * from "./compose.cjs";\nexport * from "./contextDiagnostics.cjs";\nexport * from "./contextHealth.cjs";\nexport * from "./contextLedger.cjs";\nexport * from "./diffSnapshot.cjs";\nexport * from "./finalStatus.cjs";\nexport * from "./fleetResult.cjs";\nexport * from "./inlineApproval.cjs";\nexport * from "./jsonc.cjs";\nexport * from "./mcpConfigImport.cjs";\nexport * from "./mcpConfigValidation.cjs";\nexport * from "./mcpElicitation.cjs";\nexport * from "./mcpManager.cjs";\nexport * from "./mcpToolIdentity.cjs";\nexport * from "./mcpUrlElicitation.cjs";\nexport * from "./modelAuth.cjs";\nexport * from "./modelCatalog.cjs";\nexport * from "./modelSetup.cjs";\nexport * from "./promptProfile.cjs";\nexport * from "./providerReplay.cjs";\nexport * from "./questionConfirmation.cjs";\nexport * from "./questionDetection.cjs";\nexport * from "./retrievalDeletion.cjs";\nexport * from "./retrievalFingerprint.cjs";\nexport * from "./retrievalMaintenance.cjs";\nexport * from "./retrievalStructuralSnapshot.cjs";\nexport * from "./retrievalHealth.cjs";\nexport * from "./retrievalPublication.cjs";\nexport * from "./retrievalQuery.cjs";\nexport * from "./retrievalRecords.cjs";\nexport * from "./selectionCommands.cjs";\nexport * from "./semanticReadiness.cjs";\nexport * from "./session.cjs";\nexport * from "./sessionHandoffDraft.cjs";\nexport * from "./structuredQuestion.cjs";\nexport * from "./surfaceModelMessage.cjs";\nexport * from "./sessionHydration.cjs";\nexport * from "./terminal.cjs";\nexport * from "./terminalSecurity.cjs";\nexport * from "./terminalSurface.cjs";\nexport * from "./todoContinuation.cjs";\nexport * from "./toolResult.cjs";\nexport * from "./webAccessPolicy.cjs";\nexport * from "./webActivity.cjs";\nexport * from "./workspaceProject.cjs";\n',
  ),
  copyFile(
    "dist/agentErrorPresentation.d.ts",
    "dist/cjs/agentErrorPresentation.d.cts",
  ),
  readFile("dist/approvalTransport.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/approvalTransport.d.cts",
      content
        .replaceAll('"./inlineApproval.js"', '"./inlineApproval.cjs"')
        .replaceAll('"./terminalSecurity.js"', '"./terminalSecurity.cjs"'),
    ),
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
    "dist/browserGatewayAskAgentIdentity.d.ts",
    "dist/cjs/browserGatewayAskAgentIdentity.d.cts",
  ),
  copyFile(
    "dist/browserGatewayBackgroundSummary.d.ts",
    "dist/cjs/browserGatewayBackgroundSummary.d.cts",
  ),
  copyFile(
    "dist/browserGatewayCapabilityStatus.d.ts",
    "dist/cjs/browserGatewayCapabilityStatus.d.cts",
  ),
  readFile("dist/browserGatewayChatWorkspaceSummary.d.ts", "utf8").then(
    (content) =>
      writeFile(
        "dist/cjs/browserGatewayChatWorkspaceSummary.d.cts",
        content.replaceAll('"./chatWorkspace.js"', '"./chatWorkspace.cjs"'),
      ),
  ),
  copyFile(
    "dist/browserGatewayContextBudget.d.ts",
    "dist/cjs/browserGatewayContextBudget.d.cts",
  ),
  readFile("dist/browserGatewayCoreOwnerRegistration.d.ts", "utf8").then(
    (content) =>
      writeFile(
        "dist/cjs/browserGatewayCoreOwnerRegistration.d.cts",
        content.replaceAll('"./session.js"', '"./session.cjs"'),
      ),
  ),
  copyFile(
    "dist/browserGatewayDataPlaneIdentity.d.ts",
    "dist/cjs/browserGatewayDataPlaneIdentity.d.cts",
  ),
  readFile("dist/browserGatewayDataPlaneLimits.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/browserGatewayDataPlaneLimits.d.cts",
      content
        .replaceAll(
          '"./browserGatewayDataPlaneIdentity.js"',
          '"./browserGatewayDataPlaneIdentity.cjs"',
        )
        .replaceAll(
          '"./browserGatewayOwnerCommandMetadata.js"',
          '"./browserGatewayOwnerCommandMetadata.cjs"',
        ),
    ),
  ),
  copyFile(
    "dist/browserGatewayDataPlaneMode.d.ts",
    "dist/cjs/browserGatewayDataPlaneMode.d.cts",
  ),
  readFile("dist/browserGatewayDataPlaneTransport.d.ts", "utf8").then(
    (content) =>
      writeFile(
        "dist/cjs/browserGatewayDataPlaneTransport.d.cts",
        content
          .replaceAll(
            '"./browserGatewayCapabilityStatus.js"',
            '"./browserGatewayCapabilityStatus.cjs"',
          )
          .replaceAll(
            '"./browserGatewayDataPlaneIdentity.js"',
            '"./browserGatewayDataPlaneIdentity.cjs"',
          )
          .replaceAll(
            '"./browserGatewayOwnerControlMetadata.js"',
            '"./browserGatewayOwnerControlMetadata.cjs"',
          )
          .replaceAll(
            '"./browserGatewayDataPlaneVersion.js"',
            '"./browserGatewayDataPlaneVersion.cjs"',
          ),
      ),
  ),
  copyFile(
    "dist/browserGatewayDataPlaneVersion.d.ts",
    "dist/cjs/browserGatewayDataPlaneVersion.d.cts",
  ),
  copyFile(
    "dist/browserGatewayDetachedSessionSelection.d.ts",
    "dist/cjs/browserGatewayDetachedSessionSelection.d.cts",
  ),
  readFile("dist/browserGatewayDiffPreview.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/browserGatewayDiffPreview.d.cts",
      content.replaceAll(
        '"./browserGatewayDataPlaneIdentity.js"',
        '"./browserGatewayDataPlaneIdentity.cjs"',
      ),
    ),
  ),
  readFile("dist/browserGatewayForegroundControlState.d.ts", "utf8").then(
    (content) =>
      writeFile(
        "dist/cjs/browserGatewayForegroundControlState.d.cts",
        content
          .replaceAll('"./terminal.js"', '"./terminal.cjs"')
          .replaceAll(
            '"./browserGatewayContextBudget.js"',
            '"./browserGatewayContextBudget.cjs"',
          )
          .replaceAll('"./chatWorkspace.js"', '"./chatWorkspace.cjs"')
          .replaceAll(
            '"./commandApprovalPolicy.js"',
            '"./commandApprovalPolicy.cjs"',
          )
          .replaceAll('"./contextHealth.js"', '"./contextHealth.cjs"')
          .replaceAll('"./modelCatalog.js"', '"./modelCatalog.cjs"')
          .replaceAll('"./sessionHydration.js"', '"./sessionHydration.cjs"'),
      ),
  ),
  readFile("dist/browserGatewayHelperLifecycle.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/browserGatewayHelperLifecycle.d.cts",
      content.replaceAll(
        '"./browserGatewayDataPlaneMode.js"',
        '"./browserGatewayDataPlaneMode.cjs"',
      ),
    ),
  ),
  copyFile(
    "dist/browserGatewayInstanceStatus.d.ts",
    "dist/cjs/browserGatewayInstanceStatus.d.cts",
  ),
  readFile("dist/browserGatewayInteractionState.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/browserGatewayInteractionState.d.cts",
      content
        .replaceAll(
          '"./browserGatewayInteractionSummary.js"',
          '"./browserGatewayInteractionSummary.cjs"',
        )
        .replaceAll(
          '"./browserGatewayOperationState.js"',
          '"./browserGatewayOperationState.cjs"',
        )
        .replaceAll(
          '"./browserGatewayQueueItem.js"',
          '"./browserGatewayQueueItem.cjs"',
        )
        .replaceAll(
          '"./browserGatewayTodoItem.js"',
          '"./browserGatewayTodoItem.cjs"',
        ),
    ),
  ),
  readFile("dist/browserGatewayInteractionSummary.d.ts", "utf8").then(
    (content) =>
      writeFile(
        "dist/cjs/browserGatewayInteractionSummary.d.cts",
        content.replaceAll(
          '"./browserGatewayDataPlaneIdentity.js"',
          '"./browserGatewayDataPlaneIdentity.cjs"',
        ),
      ),
  ),
  copyFile(
    "dist/browserGatewayModelProviderIdentity.d.ts",
    "dist/cjs/browserGatewayModelProviderIdentity.d.cts",
  ),
  readFile("dist/browserGatewayOperationState.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/browserGatewayOperationState.d.cts",
      content
        .replaceAll(
          '"./browserGatewayDataPlaneIdentity.js"',
          '"./browserGatewayDataPlaneIdentity.cjs"',
        )
        .replaceAll(
          '"./browserGatewayOwnerCommandMetadata.js"',
          '"./browserGatewayOwnerCommandMetadata.cjs"',
        ),
    ),
  ),
  readFile("dist/browserGatewayOwnerCheckpoint.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/browserGatewayOwnerCheckpoint.d.cts",
      content
        .replaceAll(
          '"./browserGatewayBackgroundSummary.js"',
          '"./browserGatewayBackgroundSummary.cjs"',
        )
        .replaceAll(
          '"./browserGatewayCapabilityStatus.js"',
          '"./browserGatewayCapabilityStatus.cjs"',
        )
        .replaceAll(
          '"./browserGatewayDataPlaneIdentity.js"',
          '"./browserGatewayDataPlaneIdentity.cjs"',
        )
        .replaceAll(
          '"./browserGatewayDataPlaneVersion.js"',
          '"./browserGatewayDataPlaneVersion.cjs"',
        )
        .replaceAll(
          '"./browserGatewayDiffPreview.js"',
          '"./browserGatewayDiffPreview.cjs"',
        )
        .replaceAll(
          '"./browserGatewayForegroundControlState.js"',
          '"./browserGatewayForegroundControlState.cjs"',
        )
        .replaceAll(
          '"./browserGatewayInteractionState.js"',
          '"./browserGatewayInteractionState.cjs"',
        )
        .replaceAll(
          '"./browserGatewayRepositoryState.js"',
          '"./browserGatewayRepositoryState.cjs"',
        )
        .replaceAll(
          '"./browserGatewaySessionCatalog.js"',
          '"./browserGatewaySessionCatalog.cjs"',
        )
        .replaceAll('"./browserGatewayTheme.js"', '"./browserGatewayTheme.cjs"')
        .replaceAll(
          '"./browserGatewayTranscriptWindow.js"',
          '"./browserGatewayTranscriptWindow.cjs"',
        ),
    ),
  ),
  readFile("dist/browserGatewayOwnerCommand.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/browserGatewayOwnerCommand.d.cts",
      content
        .replaceAll(
          '"./browserGatewayDataPlaneIdentity.js"',
          '"./browserGatewayDataPlaneIdentity.cjs"',
        )
        .replaceAll(
          '"./browserGatewayDataPlaneVersion.js"',
          '"./browserGatewayDataPlaneVersion.cjs"',
        )
        .replaceAll(
          '"./browserGatewayOwnerCommandBody.js"',
          '"./browserGatewayOwnerCommandBody.cjs"',
        )
        .replaceAll(
          '"./browserGatewayOwnerCommandMetadata.js"',
          '"./browserGatewayOwnerCommandMetadata.cjs"',
        ),
    ),
  ),
  readFile("dist/browserGatewayOwnerCommandAck.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/browserGatewayOwnerCommandAck.d.cts",
      content
        .replaceAll(
          '"./browserGatewayDataPlaneIdentity.js"',
          '"./browserGatewayDataPlaneIdentity.cjs"',
        )
        .replaceAll(
          '"./browserGatewayDataPlaneVersion.js"',
          '"./browserGatewayDataPlaneVersion.cjs"',
        )
        .replaceAll(
          '"./browserGatewayOperationState.js"',
          '"./browserGatewayOperationState.cjs"',
        ),
    ),
  ),
  readFile("dist/browserGatewayOwnerCommandBody.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/browserGatewayOwnerCommandBody.d.cts",
      content.replaceAll(
        '"./browserGatewayDataPlaneIdentity.js"',
        '"./browserGatewayDataPlaneIdentity.cjs"',
      ),
    ),
  ),
  copyFile(
    "dist/browserGatewayOwnerCommandMetadata.d.ts",
    "dist/cjs/browserGatewayOwnerCommandMetadata.d.cts",
  ),
  readFile("dist/browserGatewayOwnerControl.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/browserGatewayOwnerControl.d.cts",
      content
        .replaceAll(
          '"./browserGatewayDataPlaneIdentity.js"',
          '"./browserGatewayDataPlaneIdentity.cjs"',
        )
        .replaceAll(
          '"./browserGatewayDataPlaneVersion.js"',
          '"./browserGatewayDataPlaneVersion.cjs"',
        )
        .replaceAll(
          '"./browserGatewayOwnerControlMetadata.js"',
          '"./browserGatewayOwnerControlMetadata.cjs"',
        ),
    ),
  ),
  copyFile(
    "dist/browserGatewayOwnerControlMetadata.d.ts",
    "dist/cjs/browserGatewayOwnerControlMetadata.d.cts",
  ),
  readFile("dist/browserGatewayOwnerEvent.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/browserGatewayOwnerEvent.d.cts",
      content
        .replaceAll(
          '"./browserGatewayBackgroundSummary.js"',
          '"./browserGatewayBackgroundSummary.cjs"',
        )
        .replaceAll(
          '"./browserGatewayCapabilityStatus.js"',
          '"./browserGatewayCapabilityStatus.cjs"',
        )
        .replaceAll(
          '"./browserGatewayDataPlaneIdentity.js"',
          '"./browserGatewayDataPlaneIdentity.cjs"',
        )
        .replaceAll(
          '"./browserGatewayDataPlaneVersion.js"',
          '"./browserGatewayDataPlaneVersion.cjs"',
        )
        .replaceAll(
          '"./browserGatewayDiffPreview.js"',
          '"./browserGatewayDiffPreview.cjs"',
        )
        .replaceAll(
          '"./browserGatewayForegroundControlState.js"',
          '"./browserGatewayForegroundControlState.cjs"',
        )
        .replaceAll(
          '"./browserGatewayInteractionSummary.js"',
          '"./browserGatewayInteractionSummary.cjs"',
        )
        .replaceAll(
          '"./browserGatewayOperationState.js"',
          '"./browserGatewayOperationState.cjs"',
        )
        .replaceAll(
          '"./browserGatewayOwnerEventMetadata.js"',
          '"./browserGatewayOwnerEventMetadata.cjs"',
        )
        .replaceAll(
          '"./browserGatewayQueueItem.js"',
          '"./browserGatewayQueueItem.cjs"',
        )
        .replaceAll(
          '"./browserGatewayRepositoryState.js"',
          '"./browserGatewayRepositoryState.cjs"',
        )
        .replaceAll(
          '"./browserGatewaySessionCatalog.js"',
          '"./browserGatewaySessionCatalog.cjs"',
        )
        .replaceAll('"./browserGatewayTheme.js"', '"./browserGatewayTheme.cjs"')
        .replaceAll(
          '"./browserGatewayTodoItem.js"',
          '"./browserGatewayTodoItem.cjs"',
        )
        .replaceAll(
          '"./browserGatewayTranscriptMessage.js"',
          '"./browserGatewayTranscriptMessage.cjs"',
        )
        .replaceAll(
          '"./browserGatewayTranscriptWindow.js"',
          '"./browserGatewayTranscriptWindow.cjs"',
        ),
    ),
  ),
  copyFile(
    "dist/browserGatewayOwnerEventMetadata.d.ts",
    "dist/cjs/browserGatewayOwnerEventMetadata.d.cts",
  ),
  readFile("dist/browserGatewayOwnerInteractionPayload.d.ts", "utf8").then(
    (content) =>
      writeFile(
        "dist/cjs/browserGatewayOwnerInteractionPayload.d.cts",
        content
          .replaceAll('"./approvalTransport.js"', '"./approvalTransport.cjs"')
          .replaceAll('"./mcpElicitation.js"', '"./mcpElicitation.cjs"')
          .replaceAll('"./mcpUrlElicitation.js"', '"./mcpUrlElicitation.cjs"')
          .replaceAll(
            '"./structuredQuestion.js"',
            '"./structuredQuestion.cjs"',
          ),
      ),
  ),
  readFile("dist/browserGatewayOwnerPublicationBatch.d.ts", "utf8").then(
    (content) =>
      writeFile(
        "dist/cjs/browserGatewayOwnerPublicationBatch.d.cts",
        content
          .replaceAll(
            '"./browserGatewayDataPlaneIdentity.js"',
            '"./browserGatewayDataPlaneIdentity.cjs"',
          )
          .replaceAll(
            '"./browserGatewayDataPlaneVersion.js"',
            '"./browserGatewayDataPlaneVersion.cjs"',
          )
          .replaceAll(
            '"./browserGatewayOwnerCheckpoint.js"',
            '"./browserGatewayOwnerCheckpoint.cjs"',
          )
          .replaceAll(
            '"./browserGatewayOwnerEvent.js"',
            '"./browserGatewayOwnerEvent.cjs"',
          ),
      ),
  ),
  copyFile(
    "dist/browserGatewayProtocolError.d.ts",
    "dist/cjs/browserGatewayProtocolError.d.cts",
  ),
  copyFile(
    "dist/browserGatewayQueueItem.d.ts",
    "dist/cjs/browserGatewayQueueItem.d.cts",
  ),
  copyFile(
    "dist/browserGatewayRepositoryState.d.ts",
    "dist/cjs/browserGatewayRepositoryState.d.cts",
  ),
  readFile("dist/browserGatewaySessionCatalog.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/browserGatewaySessionCatalog.d.cts",
      content.replaceAll(
        '"./browserGatewayChatWorkspaceSummary.js"',
        '"./browserGatewayChatWorkspaceSummary.cjs"',
      ),
    ),
  ),
  copyFile(
    "dist/browserGatewayTheme.d.ts",
    "dist/cjs/browserGatewayTheme.d.cts",
  ),
  copyFile(
    "dist/browserGatewayTodoItem.d.ts",
    "dist/cjs/browserGatewayTodoItem.d.cts",
  ),
  readFile("dist/browserGatewayTranscriptBlock.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/browserGatewayTranscriptBlock.d.cts",
      content
        .replaceAll('"./backgroundResult.js"', '"./backgroundResult.cjs"')
        .replaceAll(
          '"./browserGatewayTranscriptText.js"',
          '"./browserGatewayTranscriptText.cjs"',
        )
        .replaceAll('"./modelCatalog.js"', '"./modelCatalog.cjs"'),
    ),
  ),
  readFile("dist/browserGatewayTranscriptMessage.d.ts", "utf8").then(
    (content) =>
      writeFile(
        "dist/cjs/browserGatewayTranscriptMessage.d.cts",
        content
          .replaceAll(
            '"./browserGatewayTranscriptBlock.js"',
            '"./browserGatewayTranscriptBlock.cjs"',
          )
          .replaceAll(
            '"./browserGatewayTranscriptText.js"',
            '"./browserGatewayTranscriptText.cjs"',
          ),
      ),
  ),
  readFile("dist/browserGatewayTranscriptText.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/browserGatewayTranscriptText.d.cts",
      content.replaceAll(
        '"./browserGatewayDataPlaneIdentity.js"',
        '"./browserGatewayDataPlaneIdentity.cjs"',
      ),
    ),
  ),
  readFile("dist/browserGatewayTranscriptWindow.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/browserGatewayTranscriptWindow.d.cts",
      content.replaceAll(
        '"./browserGatewayTranscriptMessage.js"',
        '"./browserGatewayTranscriptMessage.cjs"',
      ),
    ),
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
  readFile("dist/contextHealth.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/contextHealth.d.cts",
      content.replaceAll('"./retrievalHealth.js"', '"./retrievalHealth.cjs"'),
    ),
  ),
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
  readFile("dist/modelSetup.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/modelSetup.d.cts",
      content.replaceAll('"./modelCatalog.js"', '"./modelCatalog.cjs"'),
    ),
  ),
  copyFile("dist/promptProfile.d.ts", "dist/cjs/promptProfile.d.cts"),
  copyFile("dist/providerReplay.d.ts", "dist/cjs/providerReplay.d.cts"),
  copyFile(
    "dist/questionConfirmation.d.ts",
    "dist/cjs/questionConfirmation.d.cts",
  ),
  copyFile("dist/questionDetection.d.ts", "dist/cjs/questionDetection.d.cts"),
  readFile("dist/retrievalDeletion.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/retrievalDeletion.d.cts",
      content.replaceAll('"./retrievalRecords.js"', '"./retrievalRecords.cjs"'),
    ),
  ),
  copyFile(
    "dist/retrievalFingerprint.d.ts",
    "dist/cjs/retrievalFingerprint.d.cts",
  ),
  copyFile(
    "dist/retrievalMaintenance.d.ts",
    "dist/cjs/retrievalMaintenance.d.cts",
  ),
  readFile("dist/retrievalStructuralSnapshot.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/retrievalStructuralSnapshot.d.cts",
      content
        .replaceAll(
          '"./retrievalFingerprint.js"',
          '"./retrievalFingerprint.cjs"',
        )
        .replaceAll('"./retrievalQuery.js"', '"./retrievalQuery.cjs"')
        .replaceAll('"./retrievalRecords.js"', '"./retrievalRecords.cjs"'),
    ),
  ),
  readFile("dist/retrievalHealth.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/retrievalHealth.d.cts",
      content.replaceAll(
        '"./retrievalFingerprint.js"',
        '"./retrievalFingerprint.cjs"',
      ),
    ),
  ),
  readFile("dist/retrievalPublication.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/retrievalPublication.d.cts",
      content.replaceAll('"./retrievalRecords.js"', '"./retrievalRecords.cjs"'),
    ),
  ),
  readFile("dist/retrievalQuery.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/retrievalQuery.d.cts",
      content
        .replaceAll('"./retrievalHealth.js"', '"./retrievalHealth.cjs"')
        .replaceAll('"./retrievalRecords.js"', '"./retrievalRecords.cjs"'),
    ),
  ),
  copyFile("dist/retrievalRecords.d.ts", "dist/cjs/retrievalRecords.d.cts"),
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
  copyFile(
    "dist/surfaceModelMessage.d.ts",
    "dist/cjs/surfaceModelMessage.d.cts",
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
  readFile("dist/terminalSecurity.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/terminalSecurity.d.cts",
      content.replaceAll('"./terminal.js"', '"./terminal.cjs"'),
    ),
  ),
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
  readFile("dist/webAccessPolicy.d.ts", "utf8").then((content) =>
    writeFile(
      "dist/cjs/webAccessPolicy.d.cts",
      content.replaceAll('"./webActivity.js"', '"./webActivity.cjs"'),
    ),
  ),
  copyFile("dist/webActivity.d.ts", "dist/cjs/webActivity.d.cts"),
  copyFile("dist/workspaceProject.d.ts", "dist/cjs/workspaceProject.d.cts"),
]);
