/** Collapse an embedded HTML error page to bounded human-readable evidence. */
export function summarizeHtmlErrorText(text: string): string {
  const htmlStart = text.search(/<!doctype html|<html[\s>]/i);
  if (htmlStart === -1) return text;

  const prefix = text.slice(0, htmlStart).trim();
  const html = text.slice(htmlStart);
  const parts: string[] = [];
  const heading = extractTagText(html, "h1") ?? extractTagText(html, "title");
  if (heading) parts.push(heading);
  for (const match of html.matchAll(/<li[^>]*>([^<]*)<\/li>/gi)) {
    const item = match[1].replace(/\s+/g, " ").trim();
    if (/ray id|error reference|cloudflare location/i.test(item)) {
      parts.push(item);
    }
  }
  const summary =
    parts.length > 0 ? parts.join("; ") : "[HTML error page body omitted]";
  return prefix ? `${prefix} ${summary}` : summary;
}

function extractTagText(html: string, tag: string): string | undefined {
  const match = html.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"),
  );
  if (!match) return undefined;
  const text = match[1]
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

export interface AgentErrorActions {
  signIn?: boolean;
  signInAnotherAccount?: boolean;
  condense?: boolean;
}

/** Serializable error state shared by runtime, persistence, and presentation surfaces. */
export interface AgentRuntimeErrorPresentation {
  message: string;
  retryable: boolean;
  code?: string;
  actions?: AgentErrorActions;
}
