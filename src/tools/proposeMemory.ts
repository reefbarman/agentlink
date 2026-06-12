import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import type {
  ApprovalPanelProvider,
  MemoryApprovalResponse,
} from "../approvals/ApprovalPanelProvider.js";
import {
  DiffViewProvider,
  withFileLock,
} from "../integrations/DiffViewProvider.js";
import type {
  MemoryOperation,
  MemoryScope,
  MemoryTier,
} from "../approvals/webview/types.js";
import type { OnApprovalRequest, ToolResult } from "../shared/types.js";
import { errorResult, successResult } from "../shared/types.js";

import { tryGetFirstWorkspaceRoot } from "../util/paths.js";

const MEMORY_NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,62}[a-z0-9]$/;

interface ProposeMemoryParams {
  tier: MemoryTier;
  scope: MemoryScope;
  operation: MemoryOperation;
  title: string;
  rationale: string;
  content: string;
  name?: string;
  replaces?: string;
}

interface Target {
  filePath: string;
  displayPath: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function findNormalizedRange(
  haystack: string,
  needle: string,
): [number, number] | undefined {
  const normalizedNeedle = normalizeWhitespace(needle);
  if (!normalizedNeedle) return undefined;

  for (let start = 0; start < haystack.length; start += 1) {
    if (/\s/.test(haystack[start] ?? "")) continue;
    let h = start;
    let n = 0;

    while (h < haystack.length && n < normalizedNeedle.length) {
      const hc = haystack[h];
      const nc = normalizedNeedle[n];
      if (/\s/.test(hc)) {
        while (h < haystack.length && /\s/.test(haystack[h])) h += 1;
        if (normalizedNeedle[n] === " ") n += 1;
        continue;
      }
      if (hc !== nc) break;
      h += 1;
      n += 1;
    }

    if (n === normalizedNeedle.length) return [start, h];
  }
  return undefined;
}

async function readFileIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

function projectRoot(): string {
  return tryGetFirstWorkspaceRoot() ?? process.cwd();
}

async function resolveTarget(params: ProposeMemoryParams): Promise<Target> {
  const home = os.homedir();
  const cwd = projectRoot();
  const base = params.scope === "global" ? home : cwd;

  switch (params.tier) {
    case "memory": {
      const filePath = path.join(base, ".agentlink", "memory.md");
      return {
        filePath,
        displayPath:
          params.scope === "global"
            ? "~/.agentlink/memory.md"
            : ".agentlink/memory.md",
      };
    }
    case "instructions": {
      if (params.scope === "global") {
        const filePath = path.join(home, ".agentlink", "CLAUDE.md");
        return { filePath, displayPath: "~/.agentlink/CLAUDE.md" };
      }
      for (const filename of ["AGENTS.md", "AGENT.md", "CLAUDE.md"]) {
        const filePath = path.join(cwd, filename);
        try {
          await fs.access(filePath);
          return { filePath, displayPath: filename };
        } catch {
          // Try next convention.
        }
      }
      return {
        filePath: path.join(cwd, "AGENTS.md"),
        displayPath: "AGENTS.md",
      };
    }
    case "skill": {
      const name = validateName(params);
      const filePath = path.join(
        base,
        ".agentlink",
        "skills",
        name,
        "SKILL.md",
      );
      return {
        filePath,
        displayPath:
          params.scope === "global"
            ? `~/.agentlink/skills/${name}/SKILL.md`
            : `.agentlink/skills/${name}/SKILL.md`,
      };
    }
    case "command": {
      const name = validateName(params);
      const filePath = path.join(base, ".agentlink", "commands", `${name}.md`);
      return {
        filePath,
        displayPath:
          params.scope === "global"
            ? `~/.agentlink/commands/${name}.md`
            : `.agentlink/commands/${name}.md`,
      };
    }
  }
}

function validateName(
  params: Pick<ProposeMemoryParams, "tier" | "name">,
): string {
  const name = params.name?.trim();
  if (!name) throw new Error(`${params.tier} proposals require a name`);
  if (!MEMORY_NAME_RE.test(name)) {
    throw new Error(
      `${params.tier} name must be lowercase alphanumeric with single hyphens, no leading/trailing hyphen, and at most 64 characters`,
    );
  }
  return name;
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end === -1) return {};
  const frontmatter: Record<string, string> = {};
  for (const line of content.slice(3, end).trim().split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key || !value) continue;
    frontmatter[key] = value;
  }
  return frontmatter;
}

function validateSkill(
  params: Pick<ProposeMemoryParams, "tier" | "operation" | "name" | "content">,
): void {
  if (params.tier !== "skill" || params.operation === "remove") return;
  const name = validateName(params);
  const fm = parseFrontmatter(params.content);
  if (fm.name !== name) {
    throw new Error(
      `Skill frontmatter name must match the skill directory name (${JSON.stringify(name)})`,
    );
  }
  if (!fm.description) {
    throw new Error("Skill frontmatter must include a single-line description");
  }
  if (fm.description.length > 1024) {
    throw new Error("Skill description must be at most 1024 characters");
  }
}

function buildMemoryEntry(params: ProposeMemoryParams): string {
  const content = params.content.trim();
  if (params.tier !== "memory" || params.operation === "remove") return content;
  if (/<!--\s*added \d{4}-\d{2}-\d{2}\s*-->/.test(content)) return content;
  return `${content}\n<!-- added ${todayIso()} -->`;
}

function appendEntry(existing: string, entry: string): string {
  const trimmedExisting = existing.trimEnd();
  const trimmedEntry = entry.trim();
  if (!trimmedExisting) return `${trimmedEntry}\n`;
  return `${trimmedExisting}\n\n${trimmedEntry}\n`;
}

function applyProposal(existing: string, params: ProposeMemoryParams): string {
  if (params.tier === "skill" || params.tier === "command") {
    if (params.operation === "remove") return "";
    return params.content.trimEnd() + "\n";
  }

  const entry = buildMemoryEntry(params);
  if (params.operation === "add") return appendEntry(existing, entry);

  if (!params.replaces) {
    throw new Error(`${params.operation} proposals require replaces`);
  }

  const range = findNormalizedRange(existing, params.replaces);
  if (!range) {
    throw Object.assign(
      new Error("Could not find replaces text in target file"),
      {
        currentContent: existing,
      },
    );
  }

  const [start, end] = range;
  if (params.operation === "remove") {
    return `${existing.slice(0, start)}${existing.slice(end)}`.trimEnd() + "\n";
  }

  return (
    `${existing.slice(0, start)}${entry.trim()}${existing.slice(end)}`.trimEnd() +
    "\n"
  );
}

async function deleteTarget(filePath: string, tier: MemoryTier): Promise<void> {
  await fs.rm(filePath, { force: true });
  if (tier === "skill") {
    await fs.rmdir(path.dirname(filePath)).catch(() => undefined);
  }
}

function retargetedFromDecision(
  params: ProposeMemoryParams,
  decision: MemoryApprovalResponse,
  content: string,
): ProposeMemoryParams {
  return {
    ...params,
    tier: decision.memoryTier ?? params.tier,
    scope: decision.memoryScope ?? params.scope,
    name: decision.memoryName ?? params.name,
    content,
  };
}

function isSameMemoryDestination(
  a: Pick<ProposeMemoryParams, "tier" | "scope" | "name">,
  b: Pick<ProposeMemoryParams, "tier" | "scope" | "name">,
): boolean {
  return (
    a.tier === b.tier &&
    a.scope === b.scope &&
    (a.name ?? "") === (b.name ?? "")
  );
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
