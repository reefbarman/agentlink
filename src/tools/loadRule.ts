import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { ToolResult } from "../shared/types.js";
import { loadAdvertisedFile } from "./loadAdvertisedFile.js";

export interface AllowedRule {
  source: string;
  filePath: string;
  summary?: string;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;

  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;

  return content.slice(end + 4).trim();
}

export async function handleLoadRule(
  params: {
    path: string;
  },
  _approvalManager: ApprovalManager,
  _approvalPanel: ApprovalPanelProvider,
  _sessionId: string,
  advertisedRules: AllowedRule[] = [],
): Promise<ToolResult> {
  return loadAdvertisedFile({
    path: params.path,
    advertisedFiles: advertisedRules.map((rule) => ({
      name: rule.summary ? `${rule.source} — ${rule.summary}` : rule.source,
      filePath: rule.filePath,
    })),
    kind: "rule",
    pathProperty: "rulePath",
    nameProperty: "rule_name",
    allowlistLabel: "rule",
    contentTransform: stripFrontmatter,
  });
}
