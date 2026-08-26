import { lstat, readlink, realpath } from "node:fs/promises";

import path from "node:path";

export const WORKSPACE_INSTRUCTION_FILENAMES: ReadonlySet<string> = new Set([
  "AGENT.md",
  "AGENTS.md",
  "AGENTS.local.md",
  "CLAUDE.md",
]);

export type WorkspaceInstructionFileResolution =
  | { status: "missing" }
  | { status: "accepted"; canonicalPath: string }
  | {
      status: "ignored";
      reason:
        | "invalid_alias_target"
        | "missing_alias_target"
        | "non_regular_alias_target"
        | "indirect_alias_target"
        | "non_regular_file";
    };

export async function resolveWorkspaceInstructionFile(
  candidate: string,
  workspaceRoot: string,
): Promise<WorkspaceInstructionFileResolution> {
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    throw error;
  }

  if (!metadata.isSymbolicLink()) {
    return metadata.isFile()
      ? { status: "accepted", canonicalPath: await realpath(candidate) }
      : { status: "ignored", reason: "non_regular_file" };
  }

  const target = await readlink(candidate);
  if (
    path.basename(target) !== target ||
    !WORKSPACE_INSTRUCTION_FILENAMES.has(target)
  ) {
    return { status: "ignored", reason: "invalid_alias_target" };
  }

  const canonicalWorkspaceRoot = await realpath(workspaceRoot);
  const resolvedTarget = path.join(canonicalWorkspaceRoot, target);
  let targetMetadata;
  try {
    targetMetadata = await lstat(resolvedTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "ignored", reason: "missing_alias_target" };
    }
    throw error;
  }
  if (targetMetadata.isSymbolicLink() || !targetMetadata.isFile()) {
    return { status: "ignored", reason: "non_regular_alias_target" };
  }

  const canonicalTarget = await realpath(resolvedTarget);
  if (canonicalTarget !== resolvedTarget) {
    return { status: "ignored", reason: "indirect_alias_target" };
  }
  return { status: "accepted", canonicalPath: canonicalTarget };
}

export function describeIgnoredWorkspaceInstructionFile(
  candidate: string,
  reason: Extract<
    WorkspaceInstructionFileResolution,
    { status: "ignored" }
  >["reason"],
): string {
  const explanation =
    reason === "invalid_alias_target"
      ? "alias must name another declared root instruction file"
      : reason === "missing_alias_target"
        ? "alias target does not exist"
        : reason === "non_regular_alias_target"
          ? "alias target must be a regular non-symlink file"
          : reason === "indirect_alias_target"
            ? "alias target must resolve directly within the workspace root"
            : "instruction path must be a regular file";
  return `Ignored invalid workspace instruction file ${candidate}: ${explanation}.`;
}
