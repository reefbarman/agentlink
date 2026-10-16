import * as vscode from "vscode";
import type { OnApprovalRequest } from "@agentlink/protocol/inline-approval";
import type { ToolResult } from "@agentlink/protocol/tool-result";
import {
  effectiveCoreWebImageRetrievalMode,
  normalizeCoreWebAccessSettings,
} from "@agentlink/core/web-access";
import {
  WebImageToolRuntime,
  type WebImagePolicy,
  type WebImageToolCallContext,
  type WebImageToolName,
} from "@agentlink/node-host";

let runtime: WebImageToolRuntime | undefined;

/** The extension host's single web image runtime (tools and display). */
export function getVscodeWebImageRuntime(): WebImageToolRuntime {
  runtime ??= new WebImageToolRuntime();
  return runtime;
}

/** Current VS Code web image policy, read fresh for every call. */
export function readVscodeWebImagePolicy(): WebImagePolicy {
  const config = vscode.workspace.getConfiguration("agentlink");
  try {
    const settings = normalizeCoreWebAccessSettings({
      fetchBackend: config.get("webAccess.fetchBackend"),
      imageRetrieval: config.get("webAccess.imageRetrieval"),
      allowedDomains: config.get("webAccess.allowedDomains"),
      blockedDomains: config.get("webAccess.blockedDomains"),
    });
    return {
      mode: effectiveCoreWebImageRetrievalMode(settings),
      allowedDomains: settings.allowedDomains,
      blockedDomains: settings.blockedDomains,
    };
  } catch {
    // Invalid web settings fail closed.
    return { mode: "disabled", allowedDomains: [], blockedDomains: [] };
  }
}

export function isVscodeWebImageRetrievalAvailable(): boolean {
  return readVscodeWebImagePolicy().mode !== "disabled";
}

export interface VscodeWebImageCallContext {
  sessionId: string;
  turnId?: string;
  signal?: AbortSignal;
  onApprovalRequest?: OnApprovalRequest;
  /** Nested (Compose) calls must not open approval UI. */
  interactive: boolean;
}

export async function handleVscodeWebImageTool(
  toolName: WebImageToolName,
  input: Record<string, unknown>,
  context: VscodeWebImageCallContext,
): Promise<ToolResult> {
  return getVscodeWebImageRuntime().execute(
    toolName,
    input,
    callContext(context),
  );
}

/** Retrieves one public image for present_images. */
export function fetchVscodeWebImageForModel(
  input: { url?: string; candidate_id?: string },
  context: VscodeWebImageCallContext,
): Promise<ToolResult> {
  return getVscodeWebImageRuntime().fetchForModel(input, callContext(context));
}

function callContext(
  context: VscodeWebImageCallContext,
): WebImageToolCallContext {
  const onApprovalRequest = context.interactive
    ? context.onApprovalRequest
    : undefined;
  return {
    sessionId: context.sessionId,
    turnId: context.turnId || undefined,
    policy: readVscodeWebImagePolicy(),
    signal: context.signal,
    requestApproval: onApprovalRequest
      ? async (request) => {
          const raw = await onApprovalRequest(
            {
              kind: "write",
              title: request.title,
              // No targetPath: it is a project file path, and the URL is
              // already shown in the detail.
              detail: request.detail,
              choices: request.choices,
              writeChoices: request.choices,
            },
            request.sessionId,
          );
          return typeof raw === "string" ? { decision: raw } : raw;
        }
      : undefined,
  };
}
