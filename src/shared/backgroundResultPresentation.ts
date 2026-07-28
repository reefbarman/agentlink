import type { BackgroundResultState } from "../core/capabilities/background.js";

export type BackgroundResultVisualFamily =
  | "success"
  | "warning"
  | "error"
  | "cancelled";

export interface BackgroundResultPresentation {
  family: BackgroundResultVisualFamily;
  icon: string;
  title: string;
  statusText: string;
  reason?: string;
}

function humanizeTerminalReason(
  reason: string | undefined,
): string | undefined {
  const trimmed = reason?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "incomplete_expected_result") {
    return "The agent ended without returning the expected result format.";
  }
  if (trimmed === "extension_reloaded_during_run") {
    return "The extension reloaded while the background agent was running.";
  }
  if (trimmed === "outside_caller_subtree") {
    return "This session is no longer authorized to access that background result.";
  }
  if (trimmed === "cancelled_by_user") return "Cancelled by the user.";
  if (trimmed.startsWith("budget_exhausted:")) {
    return `The background agent reached its ${trimmed.slice("budget_exhausted:".length).replaceAll("_", " ")} budget.`;
  }
  return trimmed.replaceAll("_", " ");
}

export function getBackgroundResultPresentation(
  resultState: BackgroundResultState | undefined,
  legacyStatus: "completed" | "error" | "cancelled",
  terminalReason?: string,
): BackgroundResultPresentation {
  const state =
    resultState ??
    (legacyStatus === "completed"
      ? "completed"
      : legacyStatus === "cancelled"
        ? "cancelled"
        : "failed");
  const reason = humanizeTerminalReason(terminalReason);
  switch (state) {
    case "completed":
      return {
        family: "success",
        icon: "codicon-check",
        title: "Background Result",
        statusText: "completed",
      };
    case "incomplete_expected_result":
      return {
        family: "warning",
        icon: "codicon-warning",
        title: "Incomplete Result",
        statusText: "expected result missing",
        reason:
          reason ??
          "The agent ended without returning the expected result format.",
      };
    case "budget_exhausted":
      return {
        family: "warning",
        icon: "codicon-warning",
        title: "Background Stopped",
        statusText: "budget exhausted",
        reason: reason ?? "The background agent reached its budget.",
      };
    case "interrupted":
      return {
        family: "warning",
        icon: "codicon-warning",
        title: "Background Interrupted",
        statusText: "interrupted",
        reason,
      };
    case "authorization_lost":
      return {
        family: "error",
        icon: "codicon-error",
        title: "Background Failed",
        statusText: "authorization lost",
        reason,
      };
    case "cancelled":
      return {
        family: "cancelled",
        icon: "codicon-circle-slash",
        title: "Background Cancelled",
        statusText: "cancelled",
        reason,
      };
    case "running":
    case "failed":
    default:
      return {
        family: "error",
        icon: "codicon-error",
        title: "Background Failed",
        statusText: "failed",
        reason,
      };
  }
}
