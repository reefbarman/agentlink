import * as vscode from "vscode";

import type {
  ApprovalPanelProvider,
  MemoryApprovalResponse,
} from "../approvals/ApprovalPanelProvider.js";
import {
  DiffViewProvider,
  withFileLock,
} from "../integrations/DiffViewProvider.js";

import {
  applyMemoryProposal,
  isSameMemoryProposalDestination,
  retargetMemoryProposal,
  validateMemoryProposalName,
  validateMemoryProposalSkill,
  type MemoryProposalParams,
} from "../shared/memoryProposalEngine.js";
import {
  deleteMemoryProposalTarget,
  readMemoryProposalFileIfExists,
  resolveMemoryProposalTarget,
  type MemoryProposalTarget,
} from "./memoryProposalNode.js";
import type { OnApprovalRequest, ToolResult } from "../shared/types.js";
import { errorResult, successResult } from "../shared/types.js";

import { tryGetFirstWorkspaceRoot } from "../util/paths.js";

type ProposeMemoryParams = MemoryProposalParams;
type Target = MemoryProposalTarget;

const readFileIfExists = readMemoryProposalFileIfExists;
const validateName = validateMemoryProposalName;
const validateSkill = validateMemoryProposalSkill;
const applyProposal = applyMemoryProposal;
const deleteTarget = deleteMemoryProposalTarget;
const isSameMemoryDestination = isSameMemoryProposalDestination;

function projectRoot(): string {
  return tryGetFirstWorkspaceRoot() ?? process.cwd();
}

async function resolveTarget(params: ProposeMemoryParams): Promise<Target> {
  return await resolveMemoryProposalTarget(params, {
    projectRoot: projectRoot(),
  });
}

function retargetedFromDecision(
  params: ProposeMemoryParams,
  decision: MemoryApprovalResponse,
  content: string,
): ProposeMemoryParams {
  return retargetMemoryProposal(params, decision, content);
}

function isDiffTabOpen(filePath: string): boolean {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .some(
      (tab) =>
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.modified.fsPath === filePath,
    );
}

async function waitForMemoryApproval(
  approvalPanel: ApprovalPanelProvider,
  requestId: string,
  filePath: string,
  promise: Promise<MemoryApprovalResponse>,
): Promise<MemoryApprovalResponse> {
  let closeDisposable: vscode.Disposable | undefined;

  try {
    return await new Promise<MemoryApprovalResponse>((resolve, reject) => {
      let resolved = false;
      const finish = (response: MemoryApprovalResponse) => {
        if (resolved) return;
        resolved = true;
        closeDisposable?.dispose();
        resolve(response);
      };

      closeDisposable = vscode.window.tabGroups.onDidChangeTabs((event) => {
        if (resolved || event.closed.length === 0) return;
        if (!isDiffTabOpen(filePath)) {
          approvalPanel.cancelApproval(requestId);
          finish({ decision: "reject" });
        }
      });

      promise.then(finish, reject);
    });
  } finally {
    closeDisposable?.dispose();
  }
}

async function reviewProposedContentInDiff(
  target: Target,
  proposedContent: string,
  approvalPanel: ApprovalPanelProvider,
  requestId: string | undefined,
  options?: {
    onApprovalRequest?: OnApprovalRequest;
    sessionId?: string;
    validateContent?: (content: string) => void;
  },
): Promise<{
  decision: "accept" | "reject";
  finalContent?: string;
  rejectionReason?: string;
  followUp?: string;
}> {
  const diagnosticDelay = vscode.workspace
    .getConfiguration("agentlink")
    .get<number>("diagnosticDelay", 1500);

  return await withFileLock(target.filePath, async () => {
    const diffView = new DiffViewProvider(diagnosticDelay, requestId);
    let reverted = false;
    const revert = async (reason?: string) => {
      if (reverted) return;
      reverted = true;
      await diffView.revertChanges(reason);
    };

    await diffView.open(target.filePath, target.displayPath, proposedContent);

    try {
      const decision = await diffView.waitForUserDecision(
        approvalPanel,
        options?.onApprovalRequest,
        options?.sessionId,
      );

      if (decision === "reject") {
        await revert(diffView.writeApprovalResponse?.rejectionReason);
        return {
          decision: "reject",
          rejectionReason: diffView.writeApprovalResponse?.rejectionReason,
          followUp: diffView.writeApprovalResponse?.followUp,
        };
      }

      options?.validateContent?.(
        diffView.getEditedContent() ?? proposedContent,
      );
      const saved = await diffView.saveChanges();
      return {
        decision: "accept",
        finalContent: saved.finalContent ?? proposedContent,
        followUp: saved.follow_up,
      };
    } catch (err) {
      await revert().catch(() => undefined);
      throw err;
    }
  });
}

async function reviewMemoryProposalInDiff(
  target: Target,
  proposedContent: string,
  approvalPanel: ApprovalPanelProvider,
  params: ProposeMemoryParams,
  options?: {
    validateContent?: (content: string) => void;
    shouldSave?: (
      decision: MemoryApprovalResponse,
    ) => Promise<boolean> | boolean;
  },
): Promise<{
  decision: "accept" | "reject" | "retarget";
  memoryDecision?: MemoryApprovalResponse;
  finalContent?: string;
  rejectionReason?: string;
  followUp?: string;
}> {
  const diagnosticDelay = vscode.workspace
    .getConfiguration("agentlink")
    .get<number>("diagnosticDelay", 1500);

  return await withFileLock(target.filePath, async () => {
    const diffView = new DiffViewProvider(diagnosticDelay);
    let reverted = false;
    const revert = async (reason?: string) => {
      if (reverted) return;
      reverted = true;
      await diffView.revertChanges(reason);
    };

    await diffView.open(target.filePath, target.displayPath, proposedContent);

    try {
      const { promise } = approvalPanel.enqueueMemoryApproval({
        tier: params.tier,
        scope: params.scope,
        operation: params.operation,
        name: params.name,
        title: params.title,
        rationale: params.rationale,
        targetPath: target.displayPath,
        id: diffView.requestId,
      });

      const approval = await waitForMemoryApproval(
        approvalPanel,
        diffView.requestId,
        target.filePath,
        promise,
      );
      if (approval.decision === "reject") {
        await revert(approval.rejectionReason);
        return {
          decision: "reject",
          memoryDecision: approval,
          rejectionReason: approval.rejectionReason,
          followUp: approval.followUp,
        };
      }

      const shouldSave = (await options?.shouldSave?.(approval)) ?? true;
      if (!shouldSave) {
        await revert();
        return {
          decision: "retarget",
          memoryDecision: approval,
          followUp: approval.followUp,
        };
      }

      options?.validateContent?.(
        diffView.getEditedContent() ?? proposedContent,
      );
      const saved = await diffView.saveChanges();
      return {
        decision: "accept",
        memoryDecision: approval,
        finalContent: saved.finalContent ?? proposedContent,
        followUp: saved.follow_up ?? approval.followUp,
      };
    } catch (err) {
      await revert().catch(() => undefined);
      throw err;
    }
  });
}

export async function handleProposeMemory(
  params: ProposeMemoryParams,
  approvalPanel: ApprovalPanelProvider,
  onApprovalRequest?: OnApprovalRequest,
  sessionId?: string,
): Promise<ToolResult> {
  try {
    validateSkill(params);
    if (params.tier === "command") validateName(params);

    const target = await resolveTarget(params);
    const existing = await readFileIfExists(target.filePath);
    const proposedContent = applyProposal(existing, params);

    let decision: MemoryApprovalResponse | undefined;
    let retargeted = params;
    let finalTarget = target;
    let followUp: string | undefined;

    if (
      params.operation === "remove" &&
      (params.tier === "skill" || params.tier === "command")
    ) {
      const { promise } = approvalPanel.enqueueMemoryApproval({
        tier: params.tier,
        scope: params.scope,
        operation: params.operation,
        name: params.name,
        title: params.title,
        rationale: params.rationale,
        targetPath: target.displayPath,
      });

      decision = (await promise) as MemoryApprovalResponse;
      if (decision.decision === "reject") {
        return successResult({
          status: "rejected",
          path: target.displayPath,
          rejectionReason: decision.rejectionReason,
        });
      }
    } else {
      const memoryDiffDecision = await reviewMemoryProposalInDiff(
        target,
        proposedContent,
        approvalPanel,
        params,
        {
          validateContent: (content) => {
            if (params.tier === "skill") validateSkill({ ...params, content });
          },
          shouldSave: async (approval) => {
            const maybeRetargeted = retargetedFromDecision(
              params,
              approval,
              params.content,
            );
            if (maybeRetargeted.tier === "skill")
              validateSkill(maybeRetargeted);
            if (
              maybeRetargeted.tier === "skill" ||
              maybeRetargeted.tier === "command"
            ) {
              validateName(maybeRetargeted);
            }
            return isSameMemoryDestination(params, maybeRetargeted);
          },
        },
      );

      decision = memoryDiffDecision.memoryDecision;
      followUp = memoryDiffDecision.followUp;
      if (memoryDiffDecision.decision === "reject" || !decision) {
        return successResult({
          status: "rejected",
          path: target.displayPath,
          rejectionReason: memoryDiffDecision.rejectionReason,
          ...(memoryDiffDecision.followUp && {
            follow_up: memoryDiffDecision.followUp,
          }),
        });
      }
    }

    retargeted = retargetedFromDecision(params, decision, params.content);
    if (retargeted.tier === "skill") validateSkill(retargeted);
    if (retargeted.tier === "skill" || retargeted.tier === "command") {
      validateName(retargeted);
    }

    finalTarget = await resolveTarget(retargeted);
    followUp = followUp ?? decision.followUp;

    if (
      retargeted.operation === "remove" &&
      (retargeted.tier === "skill" || retargeted.tier === "command")
    ) {
      await deleteTarget(finalTarget.filePath, retargeted.tier);
    } else if (finalTarget.filePath !== target.filePath) {
      const latestExisting = await readFileIfExists(finalTarget.filePath);
      const proposedFinalContent = applyProposal(latestExisting, retargeted);

      const diffDecision = await reviewProposedContentInDiff(
        finalTarget,
        proposedFinalContent,
        approvalPanel,
        undefined,
        {
          onApprovalRequest,
          sessionId,
          validateContent: (content) => {
            if (retargeted.tier === "skill")
              validateSkill({ ...retargeted, content });
          },
        },
      );

      if (diffDecision.decision === "reject") {
        return successResult({
          status: "rejected",
          path: finalTarget.displayPath,
          rejectionReason: diffDecision.rejectionReason,
          ...(diffDecision.followUp && { follow_up: diffDecision.followUp }),
        });
      }
      followUp = diffDecision.followUp ?? followUp;
    }

    const diagnostics = vscode.languages.getDiagnostics(
      vscode.Uri.file(finalTarget.filePath),
    );

    return successResult({
      status: "accepted",
      path: finalTarget.displayPath,
      tier: retargeted.tier,
      scope: retargeted.scope,
      operation: retargeted.operation,
      ...(followUp && { follow_up: followUp }),
      new_diagnostics: diagnostics
        .filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
        .map((d) => ({ message: d.message, source: d.source })),
    });
  } catch (err) {
    const extra =
      err instanceof Error && "currentContent" in err
        ? {
            currentContent: (err as Error & { currentContent: string })
              .currentContent,
          }
        : undefined;
    return errorResult(err instanceof Error ? err.message : String(err), extra);
  }
}
