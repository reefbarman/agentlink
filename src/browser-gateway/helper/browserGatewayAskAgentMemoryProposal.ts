import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

import type {
  ApprovalRequest,
  DecisionMessage,
  MemoryScope,
  MemoryTier,
} from "../../approvals/webview/types.js";
import {
  applyMemoryProposal,
  retargetMemoryProposal,
  validateMemoryProposalName,
  validateMemoryProposalSkill,
  type MemoryProposalParams,
} from "../../shared/memoryProposalEngine.js";
import {
  deleteMemoryProposalTarget,
  readMemoryProposalFileIfExists,
  resolveMemoryProposalTarget,
  type MemoryProposalTarget,
} from "../../tools/memoryProposalNode.js";

export interface BrowserGatewayAskAgentMemoryProposalBridgeOptions {
  homeDir?: string;
}

export interface BrowserGatewayAskAgentMemoryProposalRequest extends MemoryProposalParams {
  nudgeId?: string;
}

interface PendingMemoryProposal {
  id: string;
  params: MemoryProposalParams;
  target: MemoryProposalTarget;
  proposedContent: string;
}

export interface BrowserGatewayAskAgentMemoryProposalResult {
  status: "accepted" | "rejected";
  path: string;
  tier: MemoryTier;
  scope: MemoryScope;
  operation: MemoryProposalParams["operation"];
  rejectionReason?: string;
  followUp?: string;
}

const memoryWriteQueues = new Map<string, Promise<void>>();

async function withMemoryWriteLock<T>(
  filePath: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = memoryWriteQueues.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  memoryWriteQueues.set(
    filePath,
    previous.then(
      () => current,
      () => current,
    ),
  );
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (memoryWriteQueues.get(filePath) === current) {
      memoryWriteQueues.delete(filePath);
    }
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function assertAllowedGlobalTarget(
  target: MemoryProposalTarget,
  params: Pick<MemoryProposalParams, "tier" | "scope">,
  homeDir: string,
): void {
  if (params.scope !== "global") {
    throw new Error("Browser Ask Agent can only propose global durable memory");
  }
  const root = path.resolve(homeDir, ".agentlink");
  const resolved = path.resolve(target.filePath);
  if (!isPathInside(resolved, root)) {
    throw new Error("Memory proposal target is outside the allowed directory");
  }

  const allowed = (() => {
    switch (params.tier) {
      case "memory":
        return resolved === path.join(root, "memory.md");
      case "instructions":
        return resolved === path.join(root, "CLAUDE.md");
      case "skill":
        return (
          isPathInside(resolved, path.join(root, "skills")) &&
          path.basename(resolved) === "SKILL.md"
        );
      case "command":
        return (
          isPathInside(resolved, path.join(root, "commands")) &&
          path.basename(resolved).endsWith(".md")
        );
    }
  })();
  if (!allowed) {
    throw new Error(
      "Memory proposal target is not an allowed durable memory path",
    );
  }
}

async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tempPath, content, "utf-8");
  await fs.rename(tempPath, filePath);
}

function validateProposal(params: MemoryProposalParams): void {
  validateMemoryProposalSkill(params);
  if (params.tier === "skill" || params.tier === "command") {
    validateMemoryProposalName(params);
  }
}

export class BrowserGatewayAskAgentMemoryProposalBridge {
  private pending: PendingMemoryProposal | null = null;
  private readonly homeDir: string;

  constructor(options: BrowserGatewayAskAgentMemoryProposalBridgeOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
  }

  getPendingApproval(): ApprovalRequest | null {
    if (!this.pending) return null;
    return this.toApprovalRequest(this.pending);
  }

  async propose(
    request: BrowserGatewayAskAgentMemoryProposalRequest,
  ): Promise<ApprovalRequest> {
    if (this.pending) {
      throw new Error("A memory proposal is already awaiting approval");
    }
    const params = this.normalizeRequest(request);
    validateProposal(params);
    const target = await resolveMemoryProposalTarget(params, {
      homeDir: this.homeDir,
      allowProjectScope: false,
    });
    assertAllowedGlobalTarget(target, params, this.homeDir);
    const existing = await readMemoryProposalFileIfExists(target.filePath);
    const proposedContent = applyMemoryProposal(existing, params);
    const pending: PendingMemoryProposal = {
      id: `ask-agent-memory-${randomUUID()}`,
      params,
      target,
      proposedContent,
    };
    this.pending = pending;
    return this.toApprovalRequest(pending);
  }

  async submitDecision(
    decision: DecisionMessage,
  ): Promise<BrowserGatewayAskAgentMemoryProposalResult> {
    const pending = this.pending;
    if (!pending || decision.id !== pending.id) {
      throw new Error("Memory approval was not found");
    }
    if (decision.decision !== "accept") {
      this.pending = null;
      return {
        status: "rejected",
        path: pending.target.displayPath,
        tier: pending.params.tier,
        scope: pending.params.scope,
        operation: pending.params.operation,
        rejectionReason: decision.rejectionReason,
        followUp: decision.followUp,
      };
    }

    const editedContent = decision.editedContent;
    const retargeted = retargetMemoryProposal(
      pending.params,
      decision,
      pending.params.content,
    );
    validateProposal({
      ...retargeted,
      content: editedContent ?? retargeted.content,
    });
    const finalTarget = await resolveMemoryProposalTarget(retargeted, {
      homeDir: this.homeDir,
      allowProjectScope: false,
    });
    assertAllowedGlobalTarget(finalTarget, retargeted, this.homeDir);

    await withMemoryWriteLock(finalTarget.filePath, async () => {
      if (
        retargeted.operation === "remove" &&
        (retargeted.tier === "skill" || retargeted.tier === "command")
      ) {
        await deleteMemoryProposalTarget(finalTarget.filePath, retargeted.tier);
        return;
      }
      const finalContent =
        editedContent ??
        applyMemoryProposal(
          await readMemoryProposalFileIfExists(finalTarget.filePath),
          retargeted,
        );
      if (retargeted.tier === "skill") {
        validateMemoryProposalSkill({ ...retargeted, content: finalContent });
      }
      await writeFileAtomic(finalTarget.filePath, finalContent);
    });

    this.pending = null;
    return {
      status: "accepted",
      path: finalTarget.displayPath,
      tier: retargeted.tier,
      scope: retargeted.scope,
      operation: retargeted.operation,
      followUp: decision.followUp,
    };
  }

  private normalizeRequest(
    request: BrowserGatewayAskAgentMemoryProposalRequest,
  ): MemoryProposalParams {
    return {
      tier: request.tier,
      scope: request.scope,
      operation: request.operation,
      title: request.title.trim(),
      rationale: request.rationale.trim(),
      content: request.content,
      ...(request.name ? { name: request.name.trim() } : {}),
      ...(request.replaces ? { replaces: request.replaces } : {}),
    };
  }

  private toApprovalRequest(pending: PendingMemoryProposal): ApprovalRequest {
    return {
      kind: "memory",
      id: pending.id,
      memoryTier: pending.params.tier,
      memoryScope: pending.params.scope,
      memoryOperation: pending.params.operation,
      memoryName: pending.params.name,
      memoryTitle: pending.params.title,
      memoryRationale: pending.params.rationale,
      memoryTargetPath: pending.target.displayPath,
      memoryContent: pending.proposedContent,
    };
  }
}
