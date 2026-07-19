const REDACTED_VALUE = "[REDACTED]";
const EXACT_SECRET_KEYS = new Set([
  "apikey",
  "authorization",
  "authtoken",
  "bearertoken",
  "clientsecret",
  "clientsharedsecret",
  "idtoken",
  "password",
  "passwords",
  "passwd",
  "privatekey",
  "refreshtoken",
  "accesstoken",
  "sessiontoken",
  "signingkey",
  "secret",
  "secrets",
  "token",
  "tokens",
  "webhooksecret",
]);

interface ValueSpan {
  start: number;
  end: number;
  key: string;
}

export interface StructuredSecretRedactionResult {
  content: string;
  redactionCount: number;
  redactedKeys: string[];
  status?: "withheld_invalid_jsonc";
}

export function getStructuredSecretRedactionMetadata(
  result: StructuredSecretRedactionResult | undefined,
): Record<string, unknown> | undefined {
  if (result?.status) {
    return { type: "structured_secret_values", status: result.status };
  }
  return result?.redactionCount
    ? { type: "structured_secret_values", count: result.redactionCount }
    : undefined;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const CONFIG_DIRECTORY_SEGMENTS = new Set([
  ".agentlink",
  ".agents",
  ".claude",
  ".continue",
  ".cursor",
  ".kilocode",
  ".roo",
  ".vscode",
]);
const CONFIG_BASENAMES = new Set([
  ".mcp.json",
  "agentlink.json",
  "cline_mcp_settings.json",
  "config.json",
  "launch.json",
  "mcp.json",
  "settings.json",
]);

export function isStructuredConfigPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? "";
  const extension = basename.endsWith(".jsonc")
    ? ".jsonc"
    : basename.endsWith(".json")
      ? ".json"
      : "";
  if (!extension) return false;
  if (segments.some((segment) => CONFIG_DIRECTORY_SEGMENTS.has(segment))) {
    return true;
  }
  if (CONFIG_BASENAMES.has(basename)) return true;
  const stem = basename.slice(0, -extension.length);
  return (
    stem === "settings" ||
    stem === "config" ||
    stem.endsWith(".settings") ||
    stem.endsWith(".config")
  );
}

export function isHighConfidenceSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (EXACT_SECRET_KEYS.has(normalized)) return true;
  return (
    /(?:api|access|refresh|auth|bearer|session|oauth)token$/.test(normalized) ||
    /(?:api|client|webhook|signing|shared)secret$/.test(normalized) ||
    normalized.endsWith("apikey") ||
    /(?:private|signing|secret|secretaccess)key$/.test(normalized) ||
    normalized.endsWith("password")
  );
}

class JsoncSecretScanner {
  private index = 0;
  readonly spans: ValueSpan[] = [];

  constructor(private readonly text: string) {}

  scan(): ValueSpan[] {
    if (this.text.charCodeAt(0) === 0xfeff) this.index += 1;
    this.skipTrivia();
    this.parseValue(true);
    this.skipTrivia();
    if (this.index !== this.text.length) this.invalid();
    return this.spans;
  }

  private invalid(): never {
    throw new Error(`Invalid JSONC at offset ${this.index}`);
  }

  private skipTrivia(): void {
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      const next = this.text[this.index + 1];
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        this.index += 1;
      } else if (char === "/" && next === "/") {
        this.index += 2;
        while (
          this.index < this.text.length &&
          this.text[this.index] !== "\n" &&
          this.text[this.index] !== "\r"
        ) {
          this.index += 1;
        }
      } else if (char === "/" && next === "*") {
        const end = this.text.indexOf("*/", this.index + 2);
        if (end < 0) this.invalid();
        this.index = end + 2;
      } else {
        break;
      }
    }
  }

  private parseString(): { value: string; end: number } {
    if (this.text[this.index] !== '"') this.invalid();
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      this.index += 1;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        const raw = this.text.slice(start, this.index);
        try {
          return { value: JSON.parse(raw) as string, end: this.index };
        } catch {
          this.invalid();
        }
      }
    }
    return this.invalid();
  }

  private parseValue(collectSecrets: boolean): number {
    this.skipTrivia();
    const start = this.index;
    const char = this.text[this.index];
    if (char === "{") return this.parseObject(collectSecrets);
    if (char === "[") return this.parseArray(collectSecrets);
    if (char === '"') {
      this.parseString();
      return this.index;
    }
    for (const literal of ["true", "false", "null"]) {
      if (this.text.startsWith(literal, this.index)) {
        this.index += literal.length;
        return this.index;
      }
    }
    const number = this.text
      .slice(this.index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
    if (!number) this.invalid();
    this.index += number.length;
    return Math.max(start, this.index);
  }

  private parseObject(collectSecrets: boolean): number {
    this.index += 1;
    this.skipTrivia();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return this.index;
    }

    while (this.index < this.text.length) {
      const key = this.parseString();
      this.skipTrivia();
      if (this.text[this.index] !== ":") this.invalid();
      this.index += 1;
      this.skipTrivia();
      const valueStart = this.index;
      const sensitive = collectSecrets && isHighConfidenceSecretKey(key.value);
      const valueEnd = this.parseValue(collectSecrets && !sensitive);
      if (sensitive) {
        this.spans.push({ start: valueStart, end: valueEnd, key: key.value });
      }
      this.skipTrivia();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return this.index;
      }
      if (this.text[this.index] !== ",") this.invalid();
      this.index += 1;
      this.skipTrivia();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return this.index;
      }
    }
    return this.invalid();
  }

  private parseArray(collectSecrets: boolean): number {
    this.index += 1;
    this.skipTrivia();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return this.index;
    }

    while (this.index < this.text.length) {
      this.parseValue(collectSecrets);
      this.skipTrivia();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return this.index;
      }
      if (this.text[this.index] !== ",") this.invalid();
      this.index += 1;
      this.skipTrivia();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return this.index;
      }
    }
    return this.invalid();
  }
}

function replacementPreservingLines(
  original: string,
  value = REDACTED_VALUE,
): string {
  const placeholder = JSON.stringify(value);
  let insertedPlaceholder = false;
  const replacement = original.replace(/[^\r\n]+/g, () => {
    if (insertedPlaceholder) return " ";
    insertedPlaceholder = true;
    return placeholder;
  });
  return insertedPlaceholder ? replacement : placeholder + original;
}

export function redactStructuredSecrets(
  content: string,
): StructuredSecretRedactionResult {
  let spans: ValueSpan[];
  try {
    spans = new JsoncSecretScanner(content)
      .scan()
      .sort((left, right) => right.start - left.start);
  } catch {
    return {
      content: replacementPreservingLines(
        content,
        "[CONTENT WITHHELD: invalid JSON/JSONC]",
      ),
      redactionCount: 0,
      redactedKeys: [],
      status: "withheld_invalid_jsonc",
    };
  }
  if (spans.length === 0) {
    return { content, redactionCount: 0, redactedKeys: [] };
  }

  let redacted = content;
  for (const span of spans) {
    redacted =
      redacted.slice(0, span.start) +
      replacementPreservingLines(redacted.slice(span.start, span.end)) +
      redacted.slice(span.end);
  }
  return {
    content: redacted,
    redactionCount: spans.length,
    redactedKeys: [...new Set(spans.map((span) => span.key))].sort(),
  };
}
