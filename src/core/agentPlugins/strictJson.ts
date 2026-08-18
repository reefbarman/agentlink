export interface StrictJsonParseError {
  readonly code: "invalid_json";
  readonly message: string;
  readonly offset: number;
  readonly path: string;
}

export interface StrictJsonDuplicateMember {
  readonly code: "duplicate_member";
  readonly message: string;
  readonly offset: number;
  readonly path: string;
  readonly parentPath: string;
  readonly key: string;
}

export type StrictJsonParseResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly duplicateMembers: readonly StrictJsonDuplicateMember[];
    }
  | { readonly ok: false; readonly error: StrictJsonParseError };

class StrictJsonParser {
  private offset = 0;
  private readonly duplicateMembers: StrictJsonDuplicateMember[] = [];

  constructor(private readonly source: string) {}

  parse(): StrictJsonParseResult {
    try {
      this.skipWhitespace();
      const value = this.parseValue("$");
      this.skipWhitespace();
      if (this.offset !== this.source.length) {
        this.fail("invalid_json", "Unexpected content after JSON value", "$");
      }
      return { ok: true, value, duplicateMembers: this.duplicateMembers };
    } catch (error) {
      if (error instanceof StrictJsonParserError) {
        return { ok: false, error: error.detail };
      }
      throw error;
    }
  }

  private parseValue(path: string): unknown {
    const char = this.source[this.offset];
    if (char === "{") return this.parseObject(path);
    if (char === "[") return this.parseArray(path);
    if (char === '"') return this.parseString(path);
    if (char === "t") return this.parseLiteral("true", true, path);
    if (char === "f") return this.parseLiteral("false", false, path);
    if (char === "n") return this.parseLiteral("null", null, path);
    if (char === "-" || (char !== undefined && /[0-9]/u.test(char))) {
      return this.parseNumber(path);
    }
    this.fail("invalid_json", "Expected a JSON value", path);
  }

  private parseObject(path: string): Record<string, unknown> {
    this.offset += 1;
    this.skipWhitespace();
    const result: Record<string, unknown> = {};
    const seen = new Set<string>();
    if (this.consume("}")) return result;

    while (true) {
      if (this.source[this.offset] !== '"') {
        this.fail("invalid_json", "Expected a quoted object member name", path);
      }
      const keyOffset = this.offset;
      const key = this.parseString(path);
      const memberPath = appendJsonPath(path, key);
      if (seen.has(key)) {
        this.duplicateMembers.push({
          code: "duplicate_member",
          message: `Duplicate JSON member '${key}'`,
          offset: keyOffset,
          path: memberPath,
          parentPath: path,
          key,
        });
      }
      seen.add(key);
      this.skipWhitespace();
      this.expect(":", memberPath);
      this.skipWhitespace();
      result[key] = this.parseValue(memberPath);
      this.skipWhitespace();
      if (this.consume("}")) return result;
      this.expect(",", path);
      this.skipWhitespace();
    }
  }

  private parseArray(path: string): unknown[] {
    this.offset += 1;
    this.skipWhitespace();
    const result: unknown[] = [];
    if (this.consume("]")) return result;

    while (true) {
      result.push(this.parseValue(`${path}[${result.length}]`));
      this.skipWhitespace();
      if (this.consume("]")) return result;
      this.expect(",", path);
      this.skipWhitespace();
    }
  }

  private parseString(path: string): string {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;
    while (this.offset < this.source.length) {
      const code = this.source.charCodeAt(this.offset);
      const char = this.source[this.offset];
      if (!escaped && char === '"') {
        this.offset += 1;
        const raw = this.source.slice(start, this.offset);
        try {
          return JSON.parse(raw) as string;
        } catch {
          this.fail("invalid_json", "Invalid JSON string", path, start);
        }
      }
      if (!escaped && code < 0x20) {
        this.fail(
          "invalid_json",
          "Unescaped control character in JSON string",
          path,
        );
      }
      if (!escaped && char === "\\") {
        escaped = true;
      } else {
        escaped = false;
      }
      this.offset += 1;
    }
    this.fail("invalid_json", "Unterminated JSON string", path, start);
  }

  private parseNumber(path: string): number {
    const remaining = this.source.slice(this.offset);
    const match = remaining.match(
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u,
    );
    if (!match) this.fail("invalid_json", "Invalid JSON number", path);
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      this.fail(
        "invalid_json",
        "JSON number is outside the supported range",
        path,
      );
    }
    return value;
  }

  private parseLiteral<T>(literal: string, value: T, path: string): T {
    if (!this.source.startsWith(literal, this.offset)) {
      this.fail("invalid_json", `Expected '${literal}'`, path);
    }
    this.offset += literal.length;
    return value;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.offset] === " " ||
      this.source[this.offset] === "\t" ||
      this.source[this.offset] === "\r" ||
      this.source[this.offset] === "\n"
    ) {
      this.offset += 1;
    }
  }

  private consume(expected: string): boolean {
    if (this.source[this.offset] !== expected) return false;
    this.offset += 1;
    return true;
  }

  private expect(expected: string, path: string): void {
    if (!this.consume(expected)) {
      this.fail("invalid_json", `Expected '${expected}'`, path);
    }
  }

  private fail(
    code: StrictJsonParseError["code"],
    message: string,
    path: string,
    offset = this.offset,
  ): never {
    throw new StrictJsonParserError({ code, message, offset, path });
  }
}

class StrictJsonParserError extends Error {
  constructor(readonly detail: StrictJsonParseError) {
    super(detail.message);
  }
}

function appendJsonPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

export function parseStrictJson(source: string): StrictJsonParseResult {
  return new StrictJsonParser(source.replace(/^\uFEFF/u, "")).parse();
}
