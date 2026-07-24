import { useMemo } from "preact/hooks";

import type { ComponentChildren } from "preact";

export type JsonToken = { text: string; cls?: string };

/** Tokenize a JSON string into highlighted spans. Non-JSON text passes
 * through as plain tokens, so partially truncated payloads render safely. */
export function tokenizeJson(src: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let i = 0;

  while (i < src.length) {
    // String
    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
        } else if (src[j] === '"') {
          j++;
          break;
        } else {
          j++;
        }
      }
      const str = src.slice(i, j);
      // Look ahead past whitespace for a colon → it's a key
      let k = j;
      while (k < src.length && (src[k] === " " || src[k] === "\t")) k++;
      const cls = src[k] === ":" ? "json-key" : "json-string";
      tokens.push({ text: str, cls });
      i = j;
      continue;
    }
    // Number
    if (src[i] === "-" || (src[i] >= "0" && src[i] <= "9")) {
      let j = i + 1;
      while (
        j < src.length &&
        ((src[j] >= "0" && src[j] <= "9") ||
          src[j] === "." ||
          src[j] === "e" ||
          src[j] === "E" ||
          src[j] === "+" ||
          src[j] === "-")
      )
        j++;
      tokens.push({ text: src.slice(i, j), cls: "json-number" });
      i = j;
      continue;
    }
    // Boolean / null
    if (src.startsWith("true", i)) {
      tokens.push({ text: "true", cls: "json-boolean" });
      i += 4;
      continue;
    }
    if (src.startsWith("false", i)) {
      tokens.push({ text: "false", cls: "json-boolean" });
      i += 5;
      continue;
    }
    if (src.startsWith("null", i)) {
      tokens.push({ text: "null", cls: "json-null" });
      i += 4;
      continue;
    }
    // Plain character (punctuation, whitespace, newlines)
    tokens.push({ text: src[i] });
    i++;
  }
  return tokens;
}

/** Render a JSON string as a highlighted <pre> block. */
export function JsonHighlight({
  json,
  className = "tool-call-code",
  renderTokenText,
}: {
  json: string;
  className?: string;
  renderTokenText?: (token: JsonToken, index: number) => ComponentChildren;
}) {
  const tokens = useMemo(() => tokenizeJson(json), [json]);
  return (
    <pre class={className}>
      {tokens.map((tok, i) => {
        const content = renderTokenText?.(tok, i) ?? tok.text;
        return tok.cls ? (
          <span key={i} class={tok.cls}>
            {content}
          </span>
        ) : (
          content
        );
      })}
    </pre>
  );
}
