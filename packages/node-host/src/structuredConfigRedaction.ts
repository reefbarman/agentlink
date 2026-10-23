import path from "node:path";

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
const CONFIG_DIRECTORY_SEGMENTS = new Set([
  ".agentlink",
  ".agents",
  ".claude",
  ".codex",
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
const HEADER_CONTAINER_KEYS = new Set([
  "headers",
  "httpheaders",
  "requestheaders",
  "customheaders",
  "extraheaders",
  "defaultheaders",
]);
const KNOWN_SECRET_VALUE =
  /^(?:"""|'''|"|')?(?:sk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/;

interface ValueSpan {
  readonly start: number;
  readonly end: number;
}

export interface NodeHostStructuredConfigRedaction {
  readonly content: string;
  readonly redacted: boolean;
  readonly status?: "withheld_invalid_jsonc" | "withheld_unsupported_config";
}

/**
 * Redact the same high-confidence JSON/JSONC config paths and value shapes as
 * VS Code without reformatting the source. TOML remains outside this node-host
 * helper until the portable package owns the shared TOML parser too.
 */
export function redactNodeHostStructuredConfig(
  filePath: string,
  content: string,
): NodeHostStructuredConfigRedaction {
  if (!isStructuredJsonConfigPath(filePath)) {
    if (/\.jsonc?$/iu.test(filePath)) return { content, redacted: false };
    return shouldWithholdUnsupportedConfig(filePath)
      ? {
          content: replacementPreservingLines(
            content,
            "[CONTENT WITHHELD: unsupported structured config]",
          ),
          redacted: true,
          status: "withheld_unsupported_config",
        }
      : { content, redacted: false };
  }
  let spans: ValueSpan[];
  try {
    spans = new JsoncSecretScanner(content).scan();
  } catch {
    return {
      content: replacementPreservingLines(
        content,
        "[CONTENT WITHHELD: invalid JSON/JSONC]",
      ),
      redacted: true,
      status: "withheld_invalid_jsonc",
    };
  }
  if (spans.length === 0) return { content, redacted: false };
  let redacted = content;
  for (const span of [...spans].sort(
    (left, right) => right.start - left.start,
  )) {
    redacted =
      redacted.slice(0, span.start) +
      replacementPreservingLines(redacted.slice(span.start, span.end)) +
      redacted.slice(span.end);
  }
  return { content: redacted, redacted: true };
}

function isStructuredJsonConfigPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/gu, "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? path.basename(normalized);
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

const SOURCE_CONFIG_EXTENSIONS = new Set([
  ".c",
  ".cjs",
  ".cpp",
  ".cs",
  ".cts",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
]);

function shouldWithholdUnsupportedConfig(filePath: string): boolean {
  const normalized = filePath.replace(/\\/gu, "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? "";
  if (/^\.?mise(?:\.[^.]+)*(?:\.local)?\.toml$/u.test(basename)) {
    return true;
  }
  if (
    basename === "config.toml" &&
    (segments.some(
      (segment, index) =>
        segment === ".config" && segments[index + 1] === "mise",
    ) ||
      segments.includes(".mise") ||
      segments.includes("mise"))
  ) {
    return true;
  }
  if (
    basename.endsWith(".toml") &&
    segments.some((segment) => CONFIG_DIRECTORY_SEGMENTS.has(segment)) &&
    (basename === "config.toml" || basename === "settings.toml")
  ) {
    return true;
  }
  if (SOURCE_CONFIG_EXTENSIONS.has(path.extname(basename))) return false;
  return basename.includes("config") || basename.includes("settings");
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isHighConfidenceSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    EXACT_SECRET_KEYS.has(normalized) ||
    /(?:api|access|refresh|auth|bearer|session|oauth)token$/u.test(
      normalized,
    ) ||
    /(?:api|client|webhook|signing|shared)secret$/u.test(normalized) ||
    normalized.endsWith("apikey") ||
    /(?:private|signing|secret|secretaccess)key$/u.test(normalized) ||
    normalized.endsWith("password")
  );
}

function isEnvStyleSecretName(key: string): boolean {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) return false;
  if (/(?:^|_)PUBLIC_KEYS?$/u.test(key)) return false;
  if (/^(?:MAX|NUM)_TOKENS?$/u.test(key)) return false;
  return /_(?:KEYS?|TOKENS?|SECRETS?|PASSWORDS?|PASSWD|PASS|PAT|CREDENTIALS?)$/u.test(
    key,
  );
}

function isSecretHeaderEntry(
  containerKey: string | undefined,
  key: string,
): boolean {
  return (
    containerKey !== undefined &&
    HEADER_CONTAINER_KEYS.has(normalizeKey(containerKey)) &&
    /(?:key|token|secret|auth|signature|cookie|password|credential|session)/u.test(
      normalizeKey(key),
    )
  );
}

class JsoncSecretScanner {
  private index = 0;
  private readonly spans: ValueSpan[] = [];

  constructor(private readonly text: string) {}

  scan(): ValueSpan[] {
    if (this.text.charCodeAt(0) === 0xfeff) this.index++;
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
        this.index++;
      } else if (char === "/" && next === "/") {
        this.index += 2;
        while (
          this.index < this.text.length &&
          this.text[this.index] !== "\n" &&
          this.text[this.index] !== "\r"
        ) {
          this.index++;
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

  private parseString(): string {
    if (this.text[this.index] !== '"') this.invalid();
    const start = this.index++;
    let escaped = false;
    while (this.index < this.text.length) {
      const char = this.text[this.index++];
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        try {
          return JSON.parse(this.text.slice(start, this.index)) as string;
        } catch {
          this.invalid();
        }
      }
    }
    return this.invalid();
  }

  private parseValue(collectSecrets: boolean, parentKey?: string): number {
    this.skipTrivia();
    const start = this.index;
    const char = this.text[this.index];
    if (char === "{") return this.parseObject(collectSecrets, parentKey);
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
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (!number) this.invalid();
    this.index += number.length;
    return Math.max(start, this.index);
  }

  private parseObject(collectSecrets: boolean, parentKey?: string): number {
    this.index++;
    this.skipTrivia();
    if (this.text[this.index] === "}") return ++this.index;
    while (this.index < this.text.length) {
      const key = this.parseString();
      this.skipTrivia();
      if (this.text[this.index] !== ":") this.invalid();
      this.index++;
      this.skipTrivia();
      const valueStart = this.index;
      const sensitiveKey =
        collectSecrets &&
        (isHighConfidenceSecretKey(key) ||
          isEnvStyleSecretName(key) ||
          isSecretHeaderEntry(parentKey, key));
      const valueEnd = this.parseValue(collectSecrets && !sensitiveKey, key);
      if (
        sensitiveKey ||
        (collectSecrets &&
          KNOWN_SECRET_VALUE.test(this.text.slice(valueStart, valueEnd)))
      ) {
        this.spans.push({ start: valueStart, end: valueEnd });
      }
      this.skipTrivia();
      if (this.text[this.index] === "}") return ++this.index;
      if (this.text[this.index] !== ",") this.invalid();
      this.index++;
      this.skipTrivia();
      if (this.text[this.index] === "}") return ++this.index;
    }
    return this.invalid();
  }

  private parseArray(collectSecrets: boolean): number {
    this.index++;
    this.skipTrivia();
    if (this.text[this.index] === "]") return ++this.index;
    while (this.index < this.text.length) {
      this.parseValue(collectSecrets);
      this.skipTrivia();
      if (this.text[this.index] === "]") return ++this.index;
      if (this.text[this.index] !== ",") this.invalid();
      this.index++;
      this.skipTrivia();
      if (this.text[this.index] === "]") return ++this.index;
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
  const replacement = original.replace(/[^\r\n]+/gu, () => {
    if (insertedPlaceholder) return " ";
    insertedPlaceholder = true;
    return placeholder;
  });
  return insertedPlaceholder ? replacement : placeholder + original;
}
