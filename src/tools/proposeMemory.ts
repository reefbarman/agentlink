import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

import type {
  ApprovalPanelProvider,
  MemoryApprovalResponse,
} from "../approvals/ApprovalPanelProvider.js";
import {
  DiffViewProvider,
  type DiffResult,
  withFileLock,
} from "../integrations/DiffViewProvider.js";

import {
  applyMemoryProposal,
  isSameMemoryProposalDestination,
  retargetMemoryProposal,
  validateMemoryProposalName,
  validateMemoryProposalSkill,
  validateMemoryProposalDirectory,
  type MemoryProposalParams,
} from "../shared/memoryProposalEngine.js";
import {
  deleteMemoryProposalTarget,
  readMemoryProposalFileIfExists,
  resolveMemoryProposalTarget,
  assertMemoryProposalTargetInsideProject,
  type MemoryProposalTarget,
} from "./memoryProposalNode.js";
import {
  errorResult,
  successResult,
  type ToolResult,
} from "@agentlink/protocol/tool-result";
import type { OnApprovalRequest } from "@agentlink/protocol/inline-approval";

import { tryGetFirstWorkspaceRoot } from "../util/paths.js";
import { getConfiguredDiagnosticDelay } from "../adapters/vscode/agentLinkConfig.js";

type ProposeMemoryParams = MemoryProposalParams;
type Target = MemoryProposalTarget;

const readFileIfExists = readMemoryProposalFileIfExists;
const validateName = validateMemoryProposalName;
const validateSkill = validateMemoryProposalSkill;
const applyProposal = applyMemoryProposal;
const deleteTarget = deleteMemoryProposalTarget;
const isSameMemoryDestination = isSameMemoryProposalDestination;

class MemorySaveError extends Error {
  constructor(readonly result: DiffResult) {
    super(result.error ?? "Approved memory proposal was not durably saved");
    this.name = "MemorySaveError";
  }
}

class MemoryTargetValidationError extends Error {
  constructor(
    error: unknown,
    readonly target: Target,
    readonly reviewOpened: boolean,
  ) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "MemoryTargetValidationError";
  }
}

async function validateReviewTarget(
  target: Target,
  validate: (() => Promise<void>) | undefined,
  reviewOpened: boolean,
): Promise<void> {
  try {
    await validate?.();
  } catch (error) {
    throw new MemoryTargetValidationError(error, target, reviewOpened);
  }
}

class MemoryReviewOpenError extends Error {
  constructor(
    message: string,
    readonly evidence: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MemoryReviewOpenError";
  }
}

async function openMemoryReview(
  diffView: DiffViewProvider,
  target: Target,
  proposedContent: string,
  priorRetargetApproval = false,
): Promise<void> {
  const baseline = await fs
    .readFile(target.filePath, "utf-8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  try {
    await diffView.open(target.filePath, target.displayPath, proposedContent);
  } catch (error) {
    let diskState: "unchanged" | "changed" | "missing" | "unreadable";
    try {
      const current = await fs.readFile(target.filePath, "utf-8");
      diskState = current === baseline ? "unchanged" : "changed";
    } catch (error) {
      diskState =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "unreadable";
    }
    throw new MemoryReviewOpenError(
      error instanceof Error ? error.message : String(error),
      {
        path: target.displayPath,
        reason: "review_open_failed",
        failure_stage: "review_open",
        approval_state: priorRetargetApproval
          ? "retarget_accepted_review_not_requested"
          : "not_requested",
        save_state: "not_attempted",
        disk_state: diskState,
        buffer_state: "unknown",
        retryable: false,
        next_steps: [
          "Approval for this target's content review was not requested and no save was attempted. Review setup may have changed the editor buffer or created an empty target. Inspect the retained editor and re-read the target before composing a new reviewed proposal; do not blindly replay or save the buffer.",
        ],
      },
    );
  }
}

function requireDurableMemorySave(result: DiffResult): string {
  if (
    result.status !== "accepted" ||
    result.durability?.status !== "durable" ||
    result.finalContent === undefined
  ) {
    throw new MemorySaveError(result);
  }
  return result.finalContent;
}

function assertAuthoritativeTier(
  params: Pick<ProposeMemoryParams, "tier">,
): void {
  if (params.tier === "memory") {
    throw new Error(
      "Low-authority memory must use manage_memory, not an approval proposal",
    );
  }
}

function projectRoot(): string {
  return tryGetFirstWorkspaceRoot() ?? process.cwd();
}

async function resolveTarget(params: ProposeMemoryParams): Promise<Target> {
  return await resolveMemoryProposalTarget(params, {
    projectRoot: projectRoot(),
    preferExistingCommandTarget: true,
  });
}

async function assertSkillTargetExists(
  target: Target,
  params: ProposeMemoryParams,
): Promise<void> {
  try {
    await fs.access(target.filePath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let hint = "";
  if (params.scope === "project") {
    const otherDirectory =
      (params.skill_directory ?? ".agentlink/skills") === ".agentlink/skills"
        ? ".agents/skills"
        : ".agentlink/skills";
    const otherTarget = path.join(
      projectRoot(),
      otherDirectory,
      params.name ?? "",
      "SKILL.md",
    );
    try {
      await fs.access(otherTarget);
      hint = ` A same-named skill exists at ${otherDirectory}/${params.name}/SKILL.md; select that directory to target it.`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Skill target not found: ${target.displayPath}.${hint}`);
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
    validateTarget?: () => Promise<void>;
  },
): Promise<{
  decision: "accept" | "reject";
  finalContent?: string;
  rejectionReason?: string;
  followUp?: string;
}> {
  const diagnosticDelay = getConfiguredDiagnosticDelay();

  return await withFileLock(target.filePath, async () => {
    const diffView = new DiffViewProvider(diagnosticDelay, requestId);
    let reverted = false;
    const revert = async (reason?: string) => {
      if (reverted) return;
      await validateReviewTarget(target, options?.validateTarget, true);
      reverted = true;
      await diffView.revertChanges(reason);
    };

    await validateReviewTarget(target, options?.validateTarget, false);
    await openMemoryReview(diffView, target, proposedContent, true);

    try {
      await validateReviewTarget(target, options?.validateTarget, true);
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
      await validateReviewTarget(target, options?.validateTarget, true);
      const saved = await diffView.saveChanges();
      return {
        decision: "accept",
        finalContent: requireDurableMemorySave(saved),
        followUp: saved.follow_up,
      };
    } catch (err) {
      if (
        !(err instanceof MemorySaveError) &&
        !(err instanceof MemoryTargetValidationError)
      ) {
        try {
          await revert();
        } catch (revertError) {
          if (revertError instanceof MemoryTargetValidationError)
            throw revertError;
        }
      }
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
    sessionId?: string;
    validateContent?: (content: string) => void;
    validateTarget?: () => Promise<void>;
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
  const diagnosticDelay = getConfiguredDiagnosticDelay();

  return await withFileLock(target.filePath, async () => {
    const diffView = new DiffViewProvider(diagnosticDelay);
    let reverted = false;
    const revert = async (reason?: string) => {
      if (reverted) return;
      await validateReviewTarget(target, options?.validateTarget, true);
      reverted = true;
      await diffView.revertChanges(reason);
    };

    await validateReviewTarget(target, options?.validateTarget, false);
    await openMemoryReview(diffView, target, proposedContent);

    try {
      const { promise } = approvalPanel.enqueueMemoryApproval({
        tier: params.tier,
        scope: params.scope,
        operation: params.operation,
        name: params.name,
        title: params.title,
        rationale: params.rationale,
        targetPath: target.filePath,
        id: diffView.requestId,
        sessionId: options?.sessionId,
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
      await validateReviewTarget(target, options?.validateTarget, true);
      const saved = await diffView.saveChanges();
      return {
        decision: "accept",
        memoryDecision: approval,
        finalContent: requireDurableMemorySave(saved),
        followUp: saved.follow_up ?? approval.followUp,
      };
    } catch (err) {
      if (
        !(err instanceof MemorySaveError) &&
        !(err instanceof MemoryTargetValidationError)
      ) {
        try {
          await revert();
        } catch (revertError) {
          if (revertError instanceof MemoryTargetValidationError)
            throw revertError;
        }
      }
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
    assertAuthoritativeTier(params);
    validateMemoryProposalDirectory(params);
    validateSkill(params);
    if (params.tier === "command") validateName(params);

    const target = await resolveTarget(params);
    if (
      params.tier === "skill" &&
      (params.operation === "update" || params.operation === "remove")
    ) {
      await withFileLock(target.filePath, async () =>
        assertSkillTargetExists(target, params),
      );
    }
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
        targetPath: target.filePath,
        sessionId,
      });

      decision = (await promise) as MemoryApprovalResponse;
      if (decision.decision === "reject") {
        return successResult({
          status: "rejected_by_user",
          path: target.displayPath,
          reason: decision.rejectionReason,
          ...(decision.followUp && { follow_up: decision.followUp }),
        });
      }
    } else {
      const memoryDiffDecision = await reviewMemoryProposalInDiff(
        target,
        proposedContent,
        approvalPanel,
        params,
        {
          sessionId,
          validateTarget:
            params.tier === "skill" &&
            params.scope === "project" &&
            (params.skill_directory ||
              params.operation === "update" ||
              params.operation === "remove")
              ? async () => {
                  if (params.skill_directory) {
                    await assertMemoryProposalTargetInsideProject(
                      target,
                      projectRoot(),
                    );
                  }
                  if (
                    params.operation === "update" ||
                    params.operation === "remove"
                  ) {
                    await assertSkillTargetExists(target, params);
                  }
                }
              : undefined,
          validateContent: (content) => {
            if (params.tier === "skill") validateSkill({ ...params, content });
          },
          shouldSave: async (approval) => {
            const maybeRetargeted = retargetedFromDecision(
              params,
              approval,
              params.content,
            );
            assertAuthoritativeTier(maybeRetargeted);
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
          status: "rejected_by_user",
          path: target.displayPath,
          reason: memoryDiffDecision.rejectionReason,
          ...(memoryDiffDecision.followUp && {
            follow_up: memoryDiffDecision.followUp,
          }),
        });
      }
    }

    retargeted = retargetedFromDecision(params, decision, params.content);
    assertAuthoritativeTier(retargeted);
    if (retargeted.tier === "skill") validateSkill(retargeted);
    if (retargeted.tier === "skill" || retargeted.tier === "command") {
      validateName(retargeted);
    }

    finalTarget = await resolveTarget(retargeted);
    if (
      retargeted.tier === "skill" &&
      (retargeted.operation === "update" || retargeted.operation === "remove")
    ) {
      await withFileLock(finalTarget.filePath, async () =>
        assertSkillTargetExists(finalTarget, retargeted),
      );
    }
    followUp = followUp ?? decision.followUp;

    if (
      retargeted.operation === "remove" &&
      (retargeted.tier === "skill" || retargeted.tier === "command")
    ) {
      await withFileLock(finalTarget.filePath, async () => {
        if (retargeted.tier === "skill") {
          await assertSkillTargetExists(finalTarget, retargeted);
        }
        if (retargeted.skill_directory) {
          await assertMemoryProposalTargetInsideProject(
            finalTarget,
            projectRoot(),
          );
        }
        await deleteTarget(finalTarget.filePath, retargeted.tier);
      });
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
          validateTarget:
            retargeted.tier === "skill" &&
            retargeted.scope === "project" &&
            (retargeted.skill_directory ||
              retargeted.operation === "update" ||
              retargeted.operation === "remove")
              ? async () => {
                  if (retargeted.skill_directory) {
                    await assertMemoryProposalTargetInsideProject(
                      finalTarget,
                      projectRoot(),
                    );
                  }
                  if (
                    retargeted.operation === "update" ||
                    retargeted.operation === "remove"
                  ) {
                    await assertSkillTargetExists(finalTarget, retargeted);
                  }
                }
              : undefined,
          validateContent: (content) => {
            if (retargeted.tier === "skill")
              validateSkill({ ...retargeted, content });
          },
        },
      );

      if (diffDecision.decision === "reject") {
        return successResult({
          status: "rejected_by_user",
          path: finalTarget.displayPath,
          reason: diffDecision.rejectionReason,
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
    if (err instanceof MemoryTargetValidationError) {
      return errorResult(err.message, {
        status: "error",
        reason: "proposal_target_validation_failed",
        path: err.target.displayPath,
        save_state: "not_attempted",
        rollback_state: "not_attempted",
        buffer_state: err.reviewOpened ? "retained" : "unknown",
        next_steps: [
          err.reviewOpened
            ? "The review buffer is retained. No save or rollback was attempted after target validation failed. Inspect it in VS Code and reconcile the target before retrying; do not blindly save the retained buffer."
            : "The target failed validation before review opened. Reconcile its path and existence before proposing the change again.",
        ],
      });
    }
    if (err instanceof MemoryReviewOpenError) {
      return errorResult(err.message, { ...err.evidence, status: "error" });
    }
    if (err instanceof MemorySaveError) {
      const {
        finalContent: _finalContent,
        error: _error,
        status: _status,
        ...evidence
      } = err.result;
      return errorResult(err.message, {
        ...evidence,
        status: "error",
      });
    }
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
