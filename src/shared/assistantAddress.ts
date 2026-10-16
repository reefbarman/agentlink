/**
 * The AgentLink Assistant's web address, as the desktop app and the browser
 * gateway link to it. Only an HTTPS origin is accepted: the Assistant never
 * serves plain HTTP, and a path or credentials in the address would be
 * ignored or leaked.
 */
export const DEFAULT_ASSISTANT_ORIGIN =
  "https://agentlink-assistant.local:8443";

/** The HTTPS origin for an entered address, or undefined if unusable. */
export function normalizeAssistantOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return undefined;
  let url: URL;
  try {
    // A bare host such as `framework16.local:8443` means HTTPS.
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)
        ? trimmed
        : `https://${trimmed}`,
    );
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return undefined;
  }
  return url.origin;
}
