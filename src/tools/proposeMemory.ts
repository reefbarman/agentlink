import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import type {
  ApprovalPanelProvider,
  MemoryApprovalResponse,
} from "../approvals/ApprovalPanelProvider.js";
import type {
  MemoryOperation,
  MemoryScope,
  MemoryTier,
} from "../approvals/webview/types.js";
import { errorResult, successResult } from "../shared/types.js";

import type { ToolResult } from "../shared/types.js";
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

function validateName(params: ProposeMemoryParams): string {
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

function validateSkill(params: ProposeMemoryParams): void {
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

async function writeContent(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
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

function targetChanged(a: Target, b: Target): boolean {
  return path.resolve(a.filePath) !== path.resolve(b.filePath);
}

export async function handleProposeMemory(
  params: ProposeMemoryParams,
  approvalPanel: ApprovalPanelProvider,
): Promise<ToolResult> {
  try {
    validateSkill(params);
    if (params.tier === "command") validateName(params);

    const target = await resolveTarget(params);
    const existing = await readFileIfExists(target.filePath);
    const proposedContent = applyProposal(existing, params);

    const { promise } = approvalPanel.enqueueMemoryApproval({
      tier: params.tier,
      scope: params.scope,
      operation: params.operation,
      name: params.name,
      title: params.title,
      rationale: params.rationale,
      targetPath: target.displayPath,
      content: params.content,
      proposedContent,
    });

    const decision = (await promise) as MemoryApprovalResponse;
    if (decision.decision === "reject") {
      return successResult({
        status: "rejected",
        path: target.displayPath,
        rejectionReason: decision.rejectionReason,
      });
    }

    const editedContent = decision.editedContent;
    const retargeted = retargetedFromDecision(
      params,
      decision,
      editedContent ?? params.content,
    );
    if (retargeted.tier === "skill") validateSkill(retargeted);
    if (retargeted.tier === "skill" || retargeted.tier === "command") {
      validateName(retargeted);
    }

    const finalTarget = await resolveTarget(retargeted);
    let finalContent = editedContent;

    if (targetChanged(target, finalTarget) && finalContent === undefined) {
      const retargetExisting = await readFileIfExists(finalTarget.filePath);
      const retargetProposedContent = applyProposal(
        retargetExisting,
        retargeted,
      );
      const { promise: retargetPromise } = approvalPanel.enqueueMemoryApproval({
        tier: retargeted.tier,
        scope: retargeted.scope,
        operation: retargeted.operation,
        name: retargeted.name,
        title: `${params.title} (retargeted)`,
        rationale:
          "The approval was retargeted, so AgentLink recomputed the preview against the new target file.",
        targetPath: finalTarget.displayPath,
        content: retargeted.content,
        proposedContent: retargetProposedContent,
      });
      const retargetDecision =
        (await retargetPromise) as MemoryApprovalResponse;
      if (retargetDecision.decision === "reject") {
        return successResult({
          status: "rejected",
          path: finalTarget.displayPath,
          rejectionReason: retargetDecision.rejectionReason,
        });
      }
      finalContent = retargetDecision.editedContent ?? retargetProposedContent;
    }

    if (finalContent === undefined) {
      const latestExisting = await readFileIfExists(finalTarget.filePath);
      finalContent = applyProposal(latestExisting, retargeted);
    }

    if (
      retargeted.operation === "remove" &&
      (retargeted.tier === "skill" || retargeted.tier === "command")
    ) {
      await deleteTarget(finalTarget.filePath, retargeted.tier);
    } else {
      await writeContent(finalTarget.filePath, finalContent);
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
