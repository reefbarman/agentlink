export const DEFAULT_SESSION_TITLE = "New Chat";
const MAX_SESSION_TITLE_CHARS = 80;

export function sanitizeSessionTitleText(text: string): string {
  return (
    text
      // Remove attachment chips echoed into prompt text
      .replace(/\[Attached: [^\]]+\]\n*/g, " ")
      // Remove injected file blocks and their full contents
      .replace(/<file path="[^"]+">[\s\S]*?<\/file>\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function buildSessionTitleFromUserText(
  text: string,
  maxChars = MAX_SESSION_TITLE_CHARS,
): string | undefined {
  const sanitized = sanitizeSessionTitleText(text);
  if (!sanitized) return undefined;
  return sanitized.slice(0, maxChars);
}
