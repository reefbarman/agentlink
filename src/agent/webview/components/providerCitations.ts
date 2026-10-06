import type { ContentBlock } from "@agentlink/protocol/chat-transcript";
import type { CoreWebCitation } from "@agentlink/protocol/web-activity";
import type { TokenizerAndRendererExtension } from "marked";

function isWebUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function getProviderCitations(
  blocks: ContentBlock[],
): CoreWebCitation[] {
  const citations: CoreWebCitation[] = [];
  for (const block of blocks) {
    if (
      block.type !== "tool_call" ||
      (block.name !== "web_search" && block.name !== "web_fetch")
    ) {
      continue;
    }
    try {
      const result = JSON.parse(block.result) as {
        citations?: unknown;
      } | null;
      if (!Array.isArray(result?.citations)) continue;
      for (const value of result.citations) {
        if (
          !value ||
          !isWebUrl(value.url) ||
          typeof value.citedText !== "string"
        ) {
          continue;
        }
        citations.push({
          url: value.url,
          citedText: value.citedText,
          ...(typeof value.title === "string" ? { title: value.title } : {}),
        });
      }
    } catch {
      // Live and remote tool results can be incomplete or unavailable.
    }
  }
  return citations;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function providerCitationExtension(
  citations: readonly CoreWebCitation[],
): TokenizerAndRendererExtension {
  return {
    name: "providerCitation",
    level: "inline",
    start(source) {
      const index = source.indexOf("\uE200");
      return index < 0 ? undefined : index;
    },
    tokenizer(source) {
      // Recognise complete citations and their unfinished streaming prefixes,
      // without consuming other provider widgets or literal code tokens.
      const match = source.match(
        /^\uE200cite\uE202[^\uE200\uE201\r\n]*(?:\uE201|$)|^\uE200(?:c(?:i(?:t(?:e)?)?)?)?$/,
      );
      if (!match) return undefined;
      return { type: "providerCitation", raw: match[0] };
    },
    renderer(token) {
      if (!token.raw.endsWith("\uE201")) return "";
      const seen = new Set<string>();
      return citations
        .filter((citation) => {
          if (
            !citation.citedText?.includes(token.raw) ||
            !isWebUrl(citation.url) ||
            seen.has(citation.url)
          ) {
            return false;
          }
          seen.add(citation.url);
          return true;
        })
        .map(
          (citation) =>
            `<a href="${escapeAttribute(citation.url)}" title="${escapeAttribute(citation.title ?? citation.url)}">[source]</a>`,
        )
        .join(" ");
    },
  };
}
