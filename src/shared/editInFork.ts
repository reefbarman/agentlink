/**
 * Request to fork a chat just before one of the user's messages and put that
 * message back in the new tab's composer for editing. Shared by the VS Code
 * webview, the browser gateway, and the extension host.
 */
export interface EditInForkRequest {
  /** Visible user messages after the target in the rendered transcript. */
  userMessagesAfter: number;
  /** The target message text exactly as the transcript rendered it. */
  expectedText: string;
  /** Text to restore into the fork's composer. */
  prompt: string;
  /** File attachments to restore into the fork's composer. */
  attachments: string[];
}

const MAX_TEXT_CHARS = 1_000_000;
const MAX_ATTACHMENTS = 100;

export function parseEditInForkRequest(
  value: unknown,
): EditInForkRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const { userMessagesAfter, expectedText, prompt, attachments } = raw;
  if (
    typeof userMessagesAfter !== "number" ||
    !Number.isInteger(userMessagesAfter) ||
    userMessagesAfter < 0 ||
    typeof expectedText !== "string" ||
    !expectedText.trim() ||
    expectedText.length > MAX_TEXT_CHARS ||
    typeof prompt !== "string" ||
    prompt.length > MAX_TEXT_CHARS
  ) {
    return undefined;
  }
  if (attachments !== undefined && !Array.isArray(attachments)) {
    return undefined;
  }
  const files = (attachments ?? []).filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  if (files.length > MAX_ATTACHMENTS) return undefined;
  return { userMessagesAfter, expectedText, prompt, attachments: files };
}
