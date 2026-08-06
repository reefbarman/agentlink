import { parse as parseToml } from "@iarna/toml";

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

type StructuredConfigFormat = "jsonc" | "toml";

export interface StructuredSecretRedactionResult {
  content: string;
  redactionCount: number;
  redactedKeys: string[];
  status?: "withheld_invalid_jsonc" | "withheld_invalid_toml";
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

function isMiseConfigPath(segments: string[], basename: string): boolean {
  if (/^\.?mise(?:\.[^.]+)*(?:\.local)?\.toml$/.test(basename)) {
    return true;
  }
  return (
    (segments.some(
      (segment, index) =>
        segment === ".config" && segments[index + 1] === "mise",
    ) ||
      segments.includes(".mise") ||
      segments.includes("mise")) &&
    basename === "config.toml"
  );
}

export function getStructuredConfigFormat(
  filePath: string,
): StructuredConfigFormat | undefined {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? "";
  if (basename.endsWith(".toml")) {
    if (isMiseConfigPath(segments, basename)) return "toml";
    if (
      segments.some((segment) => CONFIG_DIRECTORY_SEGMENTS.has(segment)) &&
      (basename === "config.toml" || basename === "settings.toml")
    ) {
      return "toml";
    }
    return undefined;
  }

  const extension = basename.endsWith(".jsonc")
    ? ".jsonc"
    : basename.endsWith(".json")
      ? ".json"
      : "";
  if (!extension) return undefined;
  if (segments.some((segment) => CONFIG_DIRECTORY_SEGMENTS.has(segment))) {
    return "jsonc";
  }
  if (CONFIG_BASENAMES.has(basename)) return "jsonc";
  const stem = basename.slice(0, -extension.length);
  return stem === "settings" ||
    stem === "config" ||
    stem.endsWith(".settings") ||
    stem.endsWith(".config")
    ? "jsonc"
    : undefined;
}

export function isStructuredConfigPath(filePath: string): boolean {
  return getStructuredConfigFormat(filePath) !== undefined;
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
  continuation = " ",
): string {
  const placeholder = JSON.stringify(value);
  let insertedPlaceholder = false;
  const replacement = original.replace(/[^\r\n]+/g, () => {
    if (insertedPlaceholder) return continuation;
    insertedPlaceholder = true;
    return placeholder;
  });
  return insertedPlaceholder ? replacement : placeholder + original;
}

function isTomlSecretKey(key: string): boolean {
  if (isHighConfidenceSecretKey(key)) return true;
  return (
    /^[A-Z][A-Z0-9_]*_TOKENS?$/.test(key) && !/^(?:MAX|NUM)_TOKENS?$/.test(key)
  );
}

class TomlSecretScanner {
  private index = 0;
  private tablePath: string[] = [];
  readonly spans: ValueSpan[] = [];

  constructor(private readonly text: string) {}

  scan(): ValueSpan[] {
    while (this.index < this.text.length) {
      this.skipTrivia();
      if (this.index >= this.text.length) break;
      if (this.text[this.index] === "[") this.parseTableHeader();
      else this.parseKeyValue(this.tablePath, true);
    }
    return this.spans;
  }

  private invalid(): never {
    throw new Error(`Unable to locate TOML value at offset ${this.index}`);
  }

  private skipTrivia(): void {
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char === " " || char === "\t" || char === "\r" || char === "\n") {
        this.index += 1;
      } else if (char === "#") {
        this.skipComment();
      } else {
        return;
      }
    }
  }

  private skipInlineTrivia(): void {
    while (this.text[this.index] === " " || this.text[this.index] === "\t") {
      this.index += 1;
    }
  }

  private skipComment(): void {
    while (
      this.index < this.text.length &&
      this.text[this.index] !== "\n" &&
      this.text[this.index] !== "\r"
    ) {
      this.index += 1;
    }
  }

  private consumeLineEnding(): void {
    if (this.text[this.index] === "\r") this.index += 1;
    if (this.text[this.index] === "\n") this.index += 1;
  }

  private parseTableHeader(): void {
    this.index += 1;
    const isArray = this.text[this.index] === "[";
    if (isArray) this.index += 1;
    const tablePath = this.parseKeyPath();
    this.skipInlineTrivia();
    if (this.text[this.index] !== "]") this.invalid();
    this.index += 1;
    if (isArray) {
      if (this.text[this.index] !== "]") this.invalid();
      this.index += 1;
    }
    this.skipInlineTrivia();
    if (this.text[this.index] === "#") this.skipComment();
    if (
      this.index < this.text.length &&
      this.text[this.index] !== "\r" &&
      this.text[this.index] !== "\n"
    ) {
      this.invalid();
    }
    this.consumeLineEnding();
    this.tablePath = tablePath;
  }

  private parseKeyValue(
    parentPath: readonly string[],
    collectSecrets: boolean,
  ): void {
    const keyPath = this.parseKeyPath();
    const key = keyPath.at(-1) as string;
    const fullPath = [...parentPath, ...keyPath];
    const sensitive = collectSecrets && fullPath.some(isTomlSecretKey);
    this.skipInlineTrivia();
    if (this.text[this.index] !== "=") this.invalid();
    this.index += 1;
    this.skipInlineTrivia();
    const start = this.index;
    this.parseValue(fullPath, collectSecrets && !sensitive);
    const end = this.index;
    if (sensitive) this.spans.push({ start, end, key });
    this.skipInlineTrivia();
    if (this.text[this.index] === "#") this.skipComment();
    if (
      this.index < this.text.length &&
      this.text[this.index] !== "\r" &&
      this.text[this.index] !== "\n"
    ) {
      this.invalid();
    }
    this.consumeLineEnding();
  }

  private parseKeyPath(): string[] {
    const keys: string[] = [];
    while (true) {
      this.skipInlineTrivia();
      keys.push(this.parseKeyPart());
      this.skipInlineTrivia();
      if (this.text[this.index] !== ".") return keys;
      this.index += 1;
    }
  }

  private parseKeyPart(): string {
    const quote = this.text[this.index];
    if (quote === "'" || quote === '"') {
      const start = this.index++;
      let escaped = false;
      while (this.index < this.text.length) {
        const char = this.text[this.index++];
        if (escaped) escaped = false;
        else if (char === "\\" && quote === '"') escaped = true;
        else if (char === quote) {
          const raw = this.text.slice(start, this.index);
          return quote === '"' ? (JSON.parse(raw) as string) : raw.slice(1, -1);
        }
      }
      return this.invalid();
    }
    const match = this.text.slice(this.index).match(/^[A-Za-z0-9_-]+/);
    if (!match) return this.invalid();
    this.index += match[0].length;
    return match[0];
  }

  private parseValue(
    parentPath: readonly string[],
    collectSecrets: boolean,
  ): void {
    const char = this.text[this.index];
    if (char === "'" || char === '"') return this.parseString(char);
    if (char === "[") return this.parseArray(parentPath, collectSecrets);
    if (char === "{") return this.parseInlineTable(parentPath, collectSecrets);
    while (this.index < this.text.length) {
      const current = this.text[this.index];
      if (["#", "\r", "\n", ",", "]", "}"].includes(current)) return;
      this.index += 1;
    }
  }

  private parseString(quote: "'" | '"'): void {
    const multiline = this.text.startsWith(quote.repeat(3), this.index);
    const delimiter = multiline ? quote.repeat(3) : quote;
    this.index += delimiter.length;
    while (this.index < this.text.length) {
      if (this.text.startsWith(delimiter, this.index)) {
        this.index += delimiter.length;
        if (multiline) while (this.text[this.index] === quote) this.index += 1;
        return;
      }
      if (this.text[this.index] === "\\" && quote === '"') this.index += 2;
      else this.index += 1;
    }
    this.invalid();
  }

  private parseArray(
    parentPath: readonly string[],
    collectSecrets: boolean,
  ): void {
    this.index += 1;
    while (true) {
      this.skipTrivia();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return;
      }
      this.parseValue(parentPath, collectSecrets);
      this.skipTrivia();
      if (this.text[this.index] === ",") this.index += 1;
      else if (this.text[this.index] === "]") {
        this.index += 1;
        return;
      } else this.invalid();
    }
  }

  private parseInlineTable(
    parentPath: readonly string[],
    collectSecrets: boolean,
  ): void {
    this.index += 1;
    while (true) {
      this.skipInlineTrivia();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return;
      }
      const keyPath = this.parseKeyPath();
      const key = keyPath.at(-1) as string;
      const fullPath = [...parentPath, ...keyPath];
      const sensitive = collectSecrets && fullPath.some(isTomlSecretKey);
      this.skipInlineTrivia();
      if (this.text[this.index] !== "=") this.invalid();
      this.index += 1;
      this.skipInlineTrivia();
      const start = this.index;
      this.parseValue(fullPath, collectSecrets && !sensitive);
      const end = this.index;
      if (sensitive) this.spans.push({ start, end, key });
      this.skipInlineTrivia();
      if (this.text[this.index] === ",") this.index += 1;
      else if (this.text[this.index] === "}") {
        this.index += 1;
        return;
      } else this.invalid();
    }
  }
}

function parseTomlForValidation(content: string): void {
  parseToml(content.replace(/\r\n?|\n/g, "\n"));
}

function scanTomlSecretSpans(content: string): ValueSpan[] {
  parseTomlForValidation(content);
  return new TomlSecretScanner(content).scan();
}

function commentPreservingLines(original: string, message: string): string {
  let insertedMessage = false;
  const replacement = original.replace(/[^\r\n]+/g, () => {
    if (insertedMessage) return "#";
    insertedMessage = true;
    return `# ${message}`;
  });
  return insertedMessage ? replacement : `# ${message}${original}`;
}

function invalidContentResult(
  content: string,
  format: StructuredConfigFormat,
): StructuredSecretRedactionResult {
  const label = format === "toml" ? "TOML" : "JSON/JSONC";
  const withheld = `[CONTENT WITHHELD: invalid ${label}]`;
  return {
    content:
      format === "toml"
        ? commentPreservingLines(content, withheld)
        : replacementPreservingLines(content, withheld),
    redactionCount: 0,
    redactedKeys: [],
    status:
      format === "toml" ? "withheld_invalid_toml" : "withheld_invalid_jsonc",
  };
}

export function redactStructuredSecrets(
  filePath: string,
  content: string,
): StructuredSecretRedactionResult {
  const format = getStructuredConfigFormat(filePath);
  if (!format) return { content, redactionCount: 0, redactedKeys: [] };

  let spans: ValueSpan[];
  try {
    spans =
      format === "toml"
        ? scanTomlSecretSpans(content)
        : new JsoncSecretScanner(content).scan();
  } catch {
    return invalidContentResult(content, format);
  }
  if (spans.length === 0) {
    return { content, redactionCount: 0, redactedKeys: [] };
  }

  let redacted = content;
  for (const span of [...spans].sort(
    (left, right) => right.start - left.start,
  )) {
    redacted =
      redacted.slice(0, span.start) +
      replacementPreservingLines(
        redacted.slice(span.start, span.end),
        REDACTED_VALUE,
        format === "toml" ? "#" : " ",
      ) +
      redacted.slice(span.end);
  }

  if (format === "toml") {
    try {
      parseTomlForValidation(redacted);
    } catch {
      return invalidContentResult(content, format);
    }
  }

  return {
    content: redacted,
    redactionCount: spans.length,
    redactedKeys: [...new Set(spans.map((span) => span.key))].sort(),
  };
}
