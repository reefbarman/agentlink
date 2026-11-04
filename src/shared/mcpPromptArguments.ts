/**
 * Argument parsing for MCP prompt slash commands (`/<server>:<prompt> ...`).
 *
 * Arguments are positional in the order the server declares them, and the
 * last positional argument takes the rest of the line, so
 * `/agent-comms:ask tab-2 can you check the build?` fills `to` and `question`.
 * `name=value` (or `name="a b"`) sets an argument explicitly, which also lets
 * the user skip optional ones. Double quotes group a value with spaces.
 */

export interface McpPromptArgumentDefinition {
  name: string;
  description?: string;
  required?: boolean;
}

export interface ActiveMcpPromptArgument {
  name: string;
  /** Value typed so far, up to the cursor. */
  value: string;
  /** Offsets of the value being edited within the argument text. */
  start: number;
  end: number;
  /** The value was typed as `name=value`. */
  named: boolean;
}

export interface ParsedMcpPromptArguments {
  values: Record<string, string>;
  /** Required arguments with no value. */
  missing: string[];
  /** The argument the cursor is editing, when one can be determined. */
  active?: ActiveMcpPromptArgument;
}

interface Token {
  /** Raw source offsets of the whole token. */
  start: number;
  end: number;
  /** Explicit argument name for `name=value`. */
  name?: string;
  /** Unquoted value. */
  value: string;
  /** Offset where the value starts (after `name=` and any opening quote). */
  valueStart: number;
}

const NAMED_ARGUMENT = /^([A-Za-z_][\w.-]*)=/;

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function readValue(
  text: string,
  index: number,
): { value: string; valueStart: number; end: number } {
  if (text[index] === '"') {
    let value = "";
    let cursor = index + 1;
    while (cursor < text.length && text[cursor] !== '"') {
      if (text[cursor] === "\\" && cursor + 1 < text.length) {
        value += text[cursor + 1];
        cursor += 2;
        continue;
      }
      value += text[cursor];
      cursor += 1;
    }
    // Include the closing quote when present.
    const end = cursor < text.length ? cursor + 1 : cursor;
    return { value, valueStart: index + 1, end };
  }
  let cursor = index;
  while (cursor < text.length && !isSpace(text[cursor])) cursor += 1;
  return { value: text.slice(index, cursor), valueStart: index, end: cursor };
}

function tokenize(text: string, names: ReadonlySet<string>): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let positionalCount = 0;
  const namedSlots = new Set<string>();
  let inFreeText = false;
  while (index < text.length) {
    while (index < text.length && isSpace(text[index])) index += 1;
    if (index >= text.length) break;
    const named = NAMED_ARGUMENT.exec(text.slice(index));
    if (!inFreeText && named && names.has(named[1]!)) {
      namedSlots.add(named[1]!);
      const read = readValue(text, index + named[0].length);
      tokens.push({
        start: index,
        end: read.end,
        name: named[1],
        value: read.value,
        valueStart: read.valueStart,
      });
      index = read.end;
      continue;
    }
    if (names.size - namedSlots.size - positionalCount <= 1) inFreeText = true;
    positionalCount += 1;
    const read = readValue(text, index);
    tokens.push({
      start: index,
      end: read.end,
      value: read.value,
      valueStart: read.valueStart,
    });
    index = read.end;
  }
  return tokens;
}

/**
 * Parse the text after the command name. `cursor` is an offset within `text`
 * used to report which argument is being edited.
 */
export function parseMcpPromptArguments(
  text: string,
  definitions: readonly McpPromptArgumentDefinition[],
  cursor = text.length,
): ParsedMcpPromptArguments {
  const names = new Set(definitions.map((definition) => definition.name));
  const tokens = tokenize(text, names);
  const values: Record<string, string> = Object.create(null);
  const owners = new Map<Token, string>();

  for (const token of tokens) {
    if (token.name) {
      values[token.name] = token.value;
      owners.set(token, token.name);
    }
  }

  const positional = tokens.filter((token) => !token.name);
  const slots = definitions
    .map((definition) => definition.name)
    .filter((name) => !(name in values));
  for (let index = 0; index < positional.length && slots.length > 0; index++) {
    const token = positional[index]!;
    const name = slots.shift()!;
    const remaining = positional.slice(index + 1);
    if (slots.length === 0 && remaining.length > 0) {
      // The last free argument takes the rest of the line verbatim.

      values[name] = [token, ...remaining].map((part) => part.value).join(" ");
      for (const rest of [token, ...remaining]) owners.set(rest, name);
      break;
    }
    values[name] = token.value;
    owners.set(token, name);
  }

  const missing = definitions
    .filter(
      (definition) =>
        definition.required === true && !(values[definition.name] ?? "").trim(),
    )
    .map((definition) => definition.name);

  return {
    values,
    missing,
    ...activeArgument(text, tokens, owners, definitions, values, cursor),
  };
}

function activeArgument(
  text: string,
  tokens: readonly Token[],
  owners: ReadonlyMap<Token, string>,
  definitions: readonly McpPromptArgumentDefinition[],
  values: Readonly<Record<string, string>>,
  cursor: number,
): { active?: ActiveMcpPromptArgument } {
  const editing = tokens.find(
    (token) => cursor >= token.start && cursor <= token.end,
  );
  if (editing) {
    const name = owners.get(editing);
    if (!name) return {};
    const start = Math.min(editing.valueStart, cursor);
    return {
      active: {
        name,
        value: text.slice(start, cursor).replace(/^"/, ""),
        start,
        end: editing.end,
        named: editing.name !== undefined,
      },
    };
  }
  // Cursor in whitespace after the arguments: the next unfilled argument.
  if (tokens.some((token) => token.start > cursor)) return {};
  const next = definitions.find((definition) => !(definition.name in values));
  return next
    ? {
        active: {
          name: next.name,
          value: "",
          start: cursor,
          end: cursor,
          named: false,
        },
      }
    : {};
}

/** Replace the active argument value with a completion, quoting if needed. */
export function applyMcpPromptCompletion(
  text: string,
  active: ActiveMcpPromptArgument,
  value: string,
): { text: string; cursor: number } {
  const quoted = /[\s"]/.test(value)
    ? `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"`
    : value;
  // A value that started with a quote replaces the quote too.
  const start =
    active.start > 0 && text[active.start - 1] === '"'
      ? active.start - 1
      : active.start;
  const before = text.slice(0, start);
  const after = text.slice(active.end);
  const separator = after.startsWith(" ") ? "" : " ";
  const next = `${before}${quoted}${separator}${after}`;
  return { text: next, cursor: before.length + quoted.length + 1 };
}

/** Short usage hint such as `<to> <question> [tone]`. */
export function formatMcpPromptSignature(
  definitions: readonly McpPromptArgumentDefinition[],
): string {
  return definitions
    .map((definition) =>
      definition.required ? `<${definition.name}>` : `[${definition.name}]`,
    )
    .join(" ");
}

/** Slash command name for a server prompt, safe to type after `/`. */
export function mcpPromptCommandName(
  serverName: string,
  promptName: string,
): string {
  return `${serverName}:${promptName}`.replace(/\s+/g, "-");
}
