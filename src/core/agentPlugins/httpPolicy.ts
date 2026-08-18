export function validateAgentPluginMcpHttpUrl(
  value: string | URL,
): string | undefined {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return "URL must be absolute HTTP or HTTPS.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "URL must use HTTP or HTTPS.";
  }
  if (url.username || url.password) {
    return "URL must not contain user information.";
  }
  if (url.hash) return "URL must not contain a fragment.";
  if (url.protocol === "http:" && !isAgentPluginLoopbackHost(url.hostname)) {
    return "Plain HTTP is allowed only for localhost or loopback IP literals.";
  }
  return undefined;
}

export function isAgentPluginLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255) &&
    Number(octets[0]) === 127
  );
}
