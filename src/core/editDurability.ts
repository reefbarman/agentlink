import * as diffLib from "diff";
import * as path from "node:path";

import { createHash } from "node:crypto";

const FORMAT_ON_SAVE_PATCH_LIMIT = 4_000;
const UNITY_SERIALIZATION_EXTENSIONS = new Set([
  ".meta",
  ".asset",
  ".unity",
  ".mat",
  ".prefab",
  ".anim",
  ".controller",
  ".physicmaterial",
]);

export type EditDurabilityPolicy = "allow_transform" | "preserve_exact";
export type EditDurabilityOutcome =
  | "exact"
  | "transformed"
  | "reverted"
  | "diverged"
  | "unverifiable";

export type EditDurabilityFailureReason =
  | "save_reverted_edit"
  | "editor_disk_diverged"
  | "post_save_file_missing"
  | "post_save_file_unreadable"
  | "exact_preservation_failed";

export interface EditDurabilityEvidence {
  status: "durable" | "failed";
  outcome: EditDurabilityOutcome;
  policy: EditDurabilityPolicy;
  baseline_exists: boolean;
  final_exists: boolean | "unknown";
  disk_changed: boolean | "unknown";
  baseline_content_hash: string;
  approved_content_hash: string;
  expected_disk_content_hash: string;
  editor_content_hash?: string;
  final_content_hash?: string;
  requires_reread: boolean;
  error_code?: string;
}

export interface FormatOnSaveReport {
  format_on_save: true;
  format_on_save_edits?: string;
  format_on_save_edits_omitted?: "size_cap";
  format_on_save_reverted_proposal?: true;
  eol_changed?: boolean;
  hint?: string;
  warnings?: string[];
}

export type EditDiskObservation =
  | { status: "readable"; content: string }
  | { status: "missing"; errorCode?: string }
  | { status: "unreadable"; errorCode?: string };

export interface EditDurabilityClassification {
  durability: EditDurabilityEvidence;
  expectedDiskContent: string;
  formatOnSaveReport?: FormatOnSaveReport;
  failureReason?: EditDurabilityFailureReason;
  error?: string;
  nextSteps?: string[];
}

export interface ClassifyEditDurabilityParams {
  relativePath: string;
  baselineExists: boolean;
  baselineContent: string;
  approvedContent: string;
  editorContent?: string;
  disk: EditDiskObservation;
  policy?: EditDurabilityPolicy;
}

export function normalizeEditorText(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

export function hashEditContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function getEditDurabilityPolicy(
  relativePath: string,
): EditDurabilityPolicy {
  return UNITY_SERIALIZATION_EXTENSIONS.has(
    path.extname(relativePath).toLowerCase(),
  )
    ? "preserve_exact"
    : "allow_transform";
}

export function deriveExpectedDiskContent(
  baselineContent: string,
  approvedContent: string,
): string {
  if (
    baselineContent.startsWith("\uFEFF") &&
    !approvedContent.startsWith("\uFEFF")
  ) {
    return `\uFEFF${approvedContent}`;
  }
  return approvedContent;
}

export function createFormatOnSaveReport(
  relativePath: string,
  expectedContent: string,
  finalContent: string,
  originalContent?: string,
): FormatOnSaveReport | undefined {
  const expectedEol = detectEol(expectedContent);
  const finalEol = detectEol(finalContent);
  const eol = expectedEol ?? finalEol ?? "\n";
  const normalizedExpected = expectedContent.replace(/\r\n|\n/g, eol);
  const normalizedFinal = finalContent.replace(/\r\n|\n/g, eol);
  const eolChanged = Boolean(
    expectedEol && finalEol && expectedEol !== finalEol,
  );

  if (normalizedExpected === normalizedFinal && !eolChanged) {
    return undefined;
  }

  const report: FormatOnSaveReport = { format_on_save: true };
  if (originalContent !== undefined && finalContent === originalContent) {
    report.format_on_save_reverted_proposal = true;
    report.hint =
      "Format-on-save restored the pre-edit file content. The proposed edit is not durable; re-read the file before composing another diff.";
  }
  if (getEditDurabilityPolicy(relativePath) === "preserve_exact") {
    report.warnings = [
      "A save participant changed a Unity serialization file that requires exact preservation. Re-read and inspect the full file before retrying.",
    ];
  }
  if (eolChanged) {
    report.eol_changed = true;
  }

  if (normalizedExpected !== normalizedFinal) {
    const patch = diffLib.createPatch(
      relativePath,
      normalizedExpected,
      normalizedFinal,
      "proposed",
      "saved",
      { context: 1 },
    );

    if (patch.length <= FORMAT_ON_SAVE_PATCH_LIMIT) {
      report.format_on_save_edits = patch;
    } else {
      report.format_on_save_edits_omitted = "size_cap";
      if (!report.format_on_save_reverted_proposal) {
        report.hint =
          "Format-on-save changed the file substantially; re-read the file before composing further diffs.";
      }
    }
  }

  return report;
}

export function classifyEditDurability(
  params: ClassifyEditDurabilityParams,
): EditDurabilityClassification {
  const policy = params.policy ?? getEditDurabilityPolicy(params.relativePath);
  const expectedDiskContent = deriveExpectedDiskContent(
    params.baselineContent,
    params.approvedContent,
  );
  const common = {
    policy,
    baseline_exists: params.baselineExists,
    baseline_content_hash: hashEditContent(params.baselineContent),
    approved_content_hash: hashEditContent(params.approvedContent),
    expected_disk_content_hash: hashEditContent(expectedDiskContent),
    ...(params.editorContent !== undefined
      ? { editor_content_hash: hashEditContent(params.editorContent) }
      : {}),
  };

  if (params.disk.status !== "readable") {
    const missing = params.disk.status === "missing";
    return {
      expectedDiskContent,
      durability: {
        status: "failed",
        outcome: "unverifiable",
        ...common,
        final_exists: missing ? false : "unknown",
        disk_changed: missing ? params.baselineExists : "unknown",
        requires_reread: true,
        ...(params.disk.errorCode ? { error_code: params.disk.errorCode } : {}),
      },
      failureReason: missing
        ? "post_save_file_missing"
        : "post_save_file_unreadable",
      error: missing
        ? "Edited file is missing after save"
        : "Edited file could not be read after save",
      nextSteps: [
        "Inspect the editor and disk state, then re-read the file before composing another edit.",
      ],
    };
  }

  const finalContent = params.disk.content;
  const formatOnSaveReport = createFormatOnSaveReport(
    params.relativePath,
    expectedDiskContent,
    finalContent,
    params.baselineExists ? params.baselineContent : undefined,
  );
  const finalFields = {
    final_exists: true as const,
    final_content_hash: hashEditContent(finalContent),
    disk_changed:
      !params.baselineExists || finalContent !== params.baselineContent,
  };

  if (
    params.editorContent !== undefined &&
    normalizeEditorText(params.editorContent) !==
      normalizeEditorText(finalContent)
  ) {
    return failedReadableClassification({
      common,
      expectedDiskContent,
      finalFields,
      formatOnSaveReport,
      outcome: "diverged",
      reason: "editor_disk_diverged",
      error: "Editor and disk content diverged after save",
    });
  }

  if (finalContent === expectedDiskContent) {
    return {
      expectedDiskContent,
      durability: {
        status: "durable",
        outcome: "exact",
        ...common,
        ...finalFields,
        requires_reread: false,
      },
    };
  }

  if (
    expectedDiskContent !== params.baselineContent &&
    finalContent === params.baselineContent
  ) {
    return failedReadableClassification({
      common,
      expectedDiskContent,
      finalFields,
      formatOnSaveReport,
      outcome: "reverted",
      reason: "save_reverted_edit",
      error: "Approved edit did not survive save",
    });
  }

  if (policy === "preserve_exact") {
    return failedReadableClassification({
      common,
      expectedDiskContent,
      finalFields,
      formatOnSaveReport,
      outcome: "transformed",
      reason: "exact_preservation_failed",
      error: "Save changed a file that requires exact preservation",
    });
  }

  return {
    expectedDiskContent,
    durability: {
      status: "durable",
      outcome: "transformed",
      ...common,
      ...finalFields,
      requires_reread:
        formatOnSaveReport?.format_on_save_edits_omitted === "size_cap",
    },
    ...(formatOnSaveReport ? { formatOnSaveReport } : {}),
  };
}

function failedReadableClassification(params: {
  common: Omit<
    EditDurabilityEvidence,
    | "status"
    | "outcome"
    | "final_exists"
    | "disk_changed"
    | "requires_reread"
    | "final_content_hash"
  >;
  expectedDiskContent: string;
  finalFields: Pick<
    EditDurabilityEvidence,
    "final_exists" | "final_content_hash" | "disk_changed"
  >;
  formatOnSaveReport?: FormatOnSaveReport;
  outcome: Extract<
    EditDurabilityOutcome,
    "transformed" | "reverted" | "diverged"
  >;
  reason: EditDurabilityFailureReason;
  error: string;
}): EditDurabilityClassification {
  return {
    expectedDiskContent: params.expectedDiskContent,
    durability: {
      status: "failed",
      outcome: params.outcome,
      ...params.common,
      ...params.finalFields,
      requires_reread: true,
    },
    ...(params.formatOnSaveReport
      ? { formatOnSaveReport: params.formatOnSaveReport }
      : {}),
    failureReason: params.reason,
    error: params.error,
    nextSteps: [
      "Re-read the file before composing another edit.",
      "Inspect format-on-save, save participants, and the current editor state before retrying.",
    ],
  };
}

function detectEol(content: string): "\r\n" | "\n" | undefined {
  if (content.includes("\r\n")) return "\r\n";
  if (content.includes("\n")) return "\n";
  return undefined;
}
