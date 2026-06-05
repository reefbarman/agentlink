/**
 * Generate a random id that works in both secure and insecure browsing
 * contexts.
 *
 * `crypto.randomUUID()` is only exposed in secure contexts (HTTPS or
 * localhost). The browser remote gateway is served over plain HTTP, so when a
 * remote session is opened from another device via a LAN IP the page is an
 * *insecure* context and `crypto.randomUUID` is `undefined` — calling it throws
 * a `TypeError`. That broke image/file paste (the error was swallowed inside an
 * async `FileReader.onload`, so the attachment chip simply never appeared).
 *
 * This helper prefers `crypto.randomUUID()` when available, falls back to
 * `crypto.getRandomValues()` (available in insecure contexts) to build a v4
 * UUID, and finally degrades to `Math.random()` if no crypto is present at all.
 */
export function randomId(): string {
  const c: Crypto | undefined =
    typeof crypto !== "undefined" ? crypto : undefined;

  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }

  if (c && typeof c.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    // Per RFC 4122 §4.4: set version (4) and variant (10xx) bits.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex: string[] = [];
    for (let i = 0; i < 256; i++) {
      hex.push((i + 0x100).toString(16).slice(1));
    }
    return (
      hex[bytes[0]] +
      hex[bytes[1]] +
      hex[bytes[2]] +
      hex[bytes[3]] +
      "-" +
      hex[bytes[4]] +
      hex[bytes[5]] +
      "-" +
      hex[bytes[6]] +
      hex[bytes[7]] +
      "-" +
      hex[bytes[8]] +
      hex[bytes[9]] +
      "-" +
      hex[bytes[10]] +
      hex[bytes[11]] +
      hex[bytes[12]] +
      hex[bytes[13]] +
      hex[bytes[14]] +
      hex[bytes[15]]
    );
  }

  // Last-resort fallback for environments without Web Crypto at all.
  return (
    "id-" +
    Date.now().toString(16) +
    "-" +
    Math.random().toString(16).slice(2, 10)
  );
}
