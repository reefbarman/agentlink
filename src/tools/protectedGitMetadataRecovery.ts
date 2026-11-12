import * as path from "path";

import { resolveBaselineProtectedGitMetadataForCwd } from "../terminal/sandbox/gitMetadataProtection.js";

export const PROTECTED_GIT_DENIAL_PATTERNS = [
  /(?:permission denied|operation not permitted|read-only file system|unable to create|could not create|failed to write)/i,
  /(?:index\.lock|ORIG_HEAD\.lock|FETCH_HEAD|objects\/tmp_object_)/i,
];

/**
 * Git's object-database writes (`hash-object -w`, `write-tree`, staging a new
 * blob) create a temporary file under `.git/objects` without naming it, so the
 * denial carries no protected path. Both lines must appear together.
 */
const GIT_OBJECT_TEMP_DENIAL =
  /^error:\s*unable to create temporary file:\s*(?:permission denied|operation not permitted|read-only file system)\s*$/im;
const GIT_OBJECT_WRITE_FAILURE =
  /^(?:fatal|error):\s*(?:unable to add .+ to database|unable to write (?:loose )?object|failed to write object|insufficient permission for adding an object)/im;

export interface ProtectedGitMetadataRecovery {
  retry_guidance: {
    code: "protected_git_metadata";
    message: string;
    automatic_retry: false;
    options: Array<{
      action: "reviewed_native_retry";
      same_command: true;
      sandbox_permissions: "require_escalated";
      reason_required: true;
      reviewed_native_execution: true;
      command: string;
      cwd?: string;
      suggested_reason: string;
    }>;
  };
  capability_code: "protected_git_metadata";
  protected_path: string;
  failure_evidence?: { code: string; message: string };
}

/**
 * Classifies a finished sandboxed command's output as a denied write to the
 * repository's protected Git metadata and builds the non-automatic reviewed
 * native retry guidance. Callers must already have established that the
 * command ran in the sandbox and has finished.
 */
export async function protectedGitMetadataRecovery(input: {
  command: string;
  output: string;
  cwd: string;
  exitCode: number | null;
  workspaceRoots: readonly string[];
  /** Include cwd in the retry option (for background reads, where the caller may not remember it). */
  includeCwd?: boolean;
}): Promise<ProtectedGitMetadataRecovery | undefined> {
  const { command, output, cwd, exitCode, workspaceRoots } = input;
  if (exitCode === null || !PROTECTED_GIT_DENIAL_PATTERNS[0].test(output)) {
    return undefined;
  }
  const internalApplyFailure =
    /^error:\s*['"]?git apply['"]? failed\s*$/im.test(output);
  const protection = await resolveBaselineProtectedGitMetadataForCwd(
    cwd,
    workspaceRoots,
  ).catch(() => undefined);
  if (!protection) return undefined;
  const normalizedMarker = protection.marker.replaceAll("\\", "/");
  const normalizedOutput = output.replaceAll("\\", "/");
  const outputLines = normalizedOutput.split(/\r?\n/);
  const protectedRoots = (protection.deniedWrite ?? [protection.marker]).map(
    (root) => root.replaceAll("\\", "/"),
  );
  const referencesProtectedPath =
    (PROTECTED_GIT_DENIAL_PATTERNS.every((pattern) => pattern.test(output)) &&
      (normalizedOutput.includes(normalizedMarker) ||
        outputLines.some((line) =>
          PROTECTED_GIT_DENIAL_PATTERNS.every((pattern) => pattern.test(line)),
        ))) ||
    // A tool or script (for example a Node EPERM) denied a write under the
    // protected Git directory itself, without naming a Git lock file.
    outputLines.some(
      (line) =>
        PROTECTED_GIT_DENIAL_PATTERNS[0].test(line) &&
        protectedRoots.some((root) => line.includes(`${root}/`)),
    ) ||
    (GIT_OBJECT_TEMP_DENIAL.test(normalizedOutput) &&
      GIT_OBJECT_WRITE_FAILURE.test(normalizedOutput));
  if (!referencesProtectedPath) return undefined;
  if (exitCode === 0 && !internalApplyFailure) {
    const protectedDenial = outputLines.some((line) => {
      if (!PROTECTED_GIT_DENIAL_PATTERNS.every((pattern) => pattern.test(line)))
        return false;
      const denial =
        /^(?:fatal|error):\s*(?:unable to create|could not create|cannot open|failed to write)\s+(['"])(.+?)\1:\s*(?:permission denied|operation not permitted|read-only file system)\s*$/i.exec(
          line,
        );
      if (!denial) return false;
      const deniedPath = path.resolve(cwd, denial[2]);
      return (protection.deniedWrite ?? [protection.marker]).some((root) => {
        const relative = path.relative(root, deniedPath);
        return (
          relative !== "" &&
          !relative.startsWith("..") &&
          !path.isAbsolute(relative)
        );
      });
    });
    if (!protectedDenial) return undefined;
  }
  return {
    retry_guidance: {
      code: "protected_git_metadata",
      message:
        "The sandbox denied a write to this repository's protected Git metadata. Earlier steps may have changed repository state; inspect it before any reviewed native retry. AgentLink will not retry automatically.",
      automatic_retry: false,
      options: [
        {
          action: "reviewed_native_retry",
          same_command: true,
          sandbox_permissions: "require_escalated",
          reason_required: true,
          reviewed_native_execution: true,
          command,
          ...(input.includeCwd ? { cwd } : {}),
          suggested_reason:
            "The command needs to write protected repository Git metadata.",
        },
      ],
    },
    capability_code: "protected_git_metadata",
    protected_path: protection.marker,
    ...((internalApplyFailure || exitCode === 0) && {
      failure_evidence: {
        code: internalApplyFailure
          ? "git_apply_failed"
          : "protected_git_write_denied",
        message: internalApplyFailure
          ? "Git reported an internal apply failure. The shell exit code does not establish that staging succeeded; inspect the index before any reviewed retry."
          : "Git reported a denied write to protected repository metadata. The shell exit code does not establish that every step succeeded; inspect repository state before any reviewed retry.",
      },
    }),
  };
}
