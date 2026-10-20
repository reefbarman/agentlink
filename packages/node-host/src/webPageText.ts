/**
 * Readable text from fetched web pages, shared by every host that offers
 * `web_fetch` (the CLI, the Assistant server and its watches).
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
};

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/giu,
    (match, entity: string) => {
      if (entity[0] === "#") {
        const code =
          entity[1] === "x" || entity[1] === "X"
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

/**
 * Readable text from HTML: scripts, styles and page chrome dropped, block
 * elements on their own lines, headings and list items marked, links kept
 * as `text (url)`. Not a full HTML parser, but enough to read a page.
 */
export function htmlToText(
  html: string,
  base: URL,
): { readonly title?: string; readonly text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  const title = titleMatch
    ? decodeEntities(titleMatch[1]!.replace(/\s+/gu, " ").trim()) || undefined
    : undefined;
  let body = html
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(
      /<(script|style|noscript|svg|template|iframe|head|nav|footer|form)\b[\s\S]*?<\/\1\s*>/giu,
      " ",
    );
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/iu.exec(body);
  if (main && main[2]!.replace(/<[^>]+>/gu, "").trim().length > 200) {
    body = main[2]!;
  }
  body = body
    .replace(
      /<h([1-6])\b[^>]*>/giu,
      (_match, level: string) => `\n\n${"#".repeat(Number(level))} `,
    )
    .replace(/<\/h[1-6]\s*>/giu, "\n\n")
    .replace(/<li\b[^>]*>/giu, "\n- ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(
      /<\/?(p|div|section|article|main|header|aside|ul|ol|table|tr|blockquote|pre|figure|figcaption|dl|dt|dd)\b[^>]*>/giu,
      "\n",
    )
    .replace(/<\/t[dh]\s*>/giu, " | ")
    .replace(
      /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/giu,
      (_match, dq?: string, sq?: string, bare?: string, inner = "") => {
        const label = inner.replace(/<[^>]+>/gu, "").trim();
        const href = decodeEntities(dq ?? sq ?? bare ?? "").trim();
        let absolute: string | undefined;
        try {
          const resolved = new URL(href, base);
          if (resolved.protocol === "http:" || resolved.protocol === "https:") {
            absolute = resolved.href;
          }
        } catch {
          absolute = undefined;
        }
        if (!label) return "";
        return absolute && absolute !== label
          ? `${label} (${absolute})`
          : label;
      },
    )
    .replace(/<[^>]+>/gu, "");
  const text = decodeEntities(body)
    .replace(/[ \t\f\v\u00a0]+/gu, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return { ...(title ? { title } : {}), text };
}

/** Content types `web_fetch` reads as text (besides HTML). */
export const READABLE_TEXT_CONTENT_TYPES =
  /^(?:text\/[a-z0-9.+-]+|application\/(?:[a-z0-9.-]+\+)?(?:json|xml)|application\/(?:javascript|x-yaml|yaml|toml))$/u;

export function isHtmlContentType(contentType: string): boolean {
  return contentType === "text/html" || contentType === "application/xhtml+xml";
}
