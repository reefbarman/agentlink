import { shell } from "electron";

/**
 * Returns the URL to hand to the system browser, or null when it must stay
 * blocked: non-web schemes and the app's own local service origins.
 */
export function externalBrowserUrl(
  url: string,
  internalOrigins: readonly string[],
): string | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  if (internalOrigins.includes(target.origin)) return null;
  return target.href;
}

export function openExternalLink(
  url: string,
  internalOrigins: readonly string[],
): void {
  const external = externalBrowserUrl(url, internalOrigins);
  if (external) void shell.openExternal(external);
}
