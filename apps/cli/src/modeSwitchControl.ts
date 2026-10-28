import type {
  WorkspaceModeSwitchConfirmation,
  WorkspaceModeSwitchDecision,
} from "@agentlink/workspace-host";

import type { PresentTuiControl } from "./tui/controlTypes.js";

/**
 * VS Code's mode-switch approval card for the model's `switch_mode`:
 * Allow or Reject, with an optional message. On Allow the message is a
 * follow-up instruction; on Reject it is the reason the model is given.
 * Cancelling the card rejects the switch.
 */
export async function confirmModeSwitchInControlPanel(
  request: WorkspaceModeSwitchConfirmation,
  presentControl: PresentTuiControl,
): Promise<WorkspaceModeSwitchDecision> {
  const reason = request.reason?.trim();
  const response = await presentControl(
    {
      id: `mode-switch:${request.sessionId}:${Date.now()}`,
      kind: "approval",
      title: `Switch to "${request.mode}" mode`,
      body: [
        `The agent wants to switch this session to ${request.modeName} mode.`,
        // Last, because the activity shelf shows the final body line.
        reason ? `Reason: ${reason}` : "No reason given.",
      ],
      options: [
        { id: "allow", label: "Allow" },
        { id: "reject", label: "Reject", tone: "danger" },
      ],
      input: { placeholder: "Optional message for the agent" },
      cancellable: true,
    },
    request.signal,
  );
  if (response.cancelled) return { approved: false };
  const message = response.text?.trim() || undefined;
  return response.optionId === "allow"
    ? { approved: true, ...(message ? { followUp: message } : {}) }
    : { approved: false, ...(message ? { rejectionReason: message } : {}) };
}
