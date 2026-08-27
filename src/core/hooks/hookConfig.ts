import { createHash } from "node:crypto";

import {
  HOOK_EVENT_NAMES,
  type CommandHookHandler,
  type HookConfiguration,
  type HookDiagnostic,
  type HookEventName,
  type HookHandler,
  type HookMatcher,
  type HookSource,
  type HookSourceDefinition,
  type RegisteredHookHandler,
} from "./contracts";

const EVENT_NAMES = new Set<string>(HOOK_EVENT_NAMES);
const SIMPLE_ALTERNATIVES = /^[A-Za-z0-9_]+(?:\|[A-Za-z0-9_]+)*$/u;
const MATCHER_IGNORED_EVENTS = new Set<HookEventName>([
  "UserPromptSubmit",
  "Stop",
  "Interrupt",
]);

export function parseHookSources(
  definitions: readonly HookSourceDefinition[],
): HookConfiguration {
  const diagnostics: HookDiagnostic[] = [];
  const handlers: RegisteredHookHandler[] = [];
  let declarationIndex = 0;

  for (const definition of definitions) {
    let document: unknown;
    try {
      document = JSON.parse(definition.content);
    } catch (error) {
      diagnostics.push({
        code: "hook_source_invalid_json",
        severity: "error",
        message: `Could not parse hook source: ${errorMessage(error)}`,
        sourceId: definition.id,
      });
      continue;
    }
    if (!isRecord(document) || !isRecord(document.hooks)) {
      diagnostics.push({
        code: "hook_source_invalid_shape",
        severity: "error",
        message: "Hook source must contain a 'hooks' object.",
        sourceId: definition.id,
        jsonPath: "$.hooks",
      });
      continue;
    }

    const source = normalizeSource(definition);
    for (const [eventText, groupsValue] of Object.entries(document.hooks)) {
      if (!EVENT_NAMES.has(eventText)) {
        diagnostics.push({
          code: "hook_event_unsupported",
          severity: "warning",
          message: `Unsupported hook event '${eventText}' was ignored.`,
          sourceId: source.id,
          jsonPath: `$.hooks.${eventText}`,
        });
        continue;
      }
      const event = eventText as HookEventName;
      if (!Array.isArray(groupsValue)) {
        diagnostics.push(
          invalidShape(
            source.id,
            event,
            `$.hooks.${event}`,
            "Event value must be an array.",
          ),
        );
        continue;
      }

      groupsValue.forEach((groupValue, groupIndex) => {
        const groupPath = `$.hooks.${event}[${groupIndex}]`;
        if (!isRecord(groupValue) || !Array.isArray(groupValue.hooks)) {
          diagnostics.push(
            invalidShape(
              source.id,
              event,
              groupPath,
              "Matcher group must contain a 'hooks' array.",
            ),
          );
          return;
        }
        const matcherResult = createMatcher(event, groupValue.matcher);
        if (matcherResult.diagnostic) {
          diagnostics.push({
            ...matcherResult.diagnostic,
            sourceId: source.id,
            event,
            jsonPath: `${groupPath}.matcher`,
          });
        }
        if (!matcherResult.matcher) return;
        const matcher = matcherResult.matcher;

        groupValue.hooks.forEach((handlerValue, handlerIndex) => {
          const handlerPath = `${groupPath}.hooks[${handlerIndex}]`;
          const parsed = parseHandler(handlerValue);
          if (!parsed.handler) {
            diagnostics.push({
              code: parsed.code ?? "hook_handler_invalid",
              severity: parsed.unsupported ? "warning" : "error",
              message: parsed.message,
              sourceId: source.id,
              event,
              jsonPath: handlerPath,
            });
            return;
          }
          if (parsed.unsupported) {
            diagnostics.push({
              code: "hook_handler_unsupported",
              severity: "warning",
              message: `Hook handler type '${parsed.handler.type}' is recognized but not executable.`,
              sourceId: source.id,
              event,
              jsonPath: handlerPath,
            });
          }
          const location = `${source.id}\u0000${event}\u0000${groupIndex}\u0000${handlerIndex}`;
          const hash = stableSha256({
            event,
            matcher: matcher.sourceText,
            handler: parsed.handler,
          });
          handlers.push({
            event,
            matcher,
            handler: parsed.handler,
            source,
            declarationIndex,
            key: stableSha256(location),
            hash,
          });
          declarationIndex += 1;
        });
      });
    }
  }

  return { handlers, diagnostics };
}

export function stableSha256(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function normalizeSource(definition: HookSourceDefinition): HookSource {
  const plugin = definition.plugin;
  return {
    id: definition.id,
    kind: definition.kind ?? (plugin ? "plugin" : "configuration"),
    reviewed: definition.reviewed ?? false,
    ...(definition.cwd ? { cwd: definition.cwd } : {}),
    env: {
      ...(plugin
        ? {
            PLUGIN_ROOT: plugin.root,
            PLUGIN_DATA: plugin.data,
            CLAUDE_PLUGIN_ROOT: plugin.root,
            CLAUDE_PLUGIN_DATA: plugin.data,
          }
        : {}),
      ...plugin?.env,
      ...definition.env,
    },
    replacements: {
      ...(plugin
        ? {
            "${PLUGIN_ROOT}": plugin.root,
            "${PLUGIN_DATA}": plugin.data,
            "${CLAUDE_PLUGIN_ROOT}": plugin.root,
            "${CLAUDE_PLUGIN_DATA}": plugin.data,
          }
        : {}),
      ...plugin?.replacements,
      ...definition.replacements,
    },
    ...(plugin ? { plugin } : {}),
  };
}

function createMatcher(
  event: HookEventName,
  value: unknown,
): {
  matcher?: HookMatcher;
  diagnostic?: Omit<HookDiagnostic, "sourceId" | "event" | "jsonPath">;
} {
  const ignored = MATCHER_IGNORED_EVENTS.has(event);
  if (value !== undefined && typeof value !== "string") {
    return {
      diagnostic: {
        code: "hook_matcher_invalid",
        severity: "error",
        message: "Hook matcher must be a string when provided.",
      },
    };
  }
  const sourceText = value as string | undefined;
  if (ignored) {
    return {
      matcher: {
        ...(sourceText !== undefined ? { sourceText } : {}),
        ignored: true,
        test: () => true,
      },
      ...(sourceText
        ? {
            diagnostic: {
              code: "hook_matcher_ignored",
              severity: "warning",
              message: `Matchers are ignored for ${event}.`,
            },
          }
        : {}),
    };
  }
  if (sourceText === undefined || sourceText === "" || sourceText === "*") {
    return {
      matcher: {
        ...(sourceText !== undefined ? { sourceText } : {}),
        ignored: false,
        test: () => true,
      },
    };
  }
  if (SIMPLE_ALTERNATIVES.test(sourceText)) {
    const alternatives = new Set(sourceText.split("|"));
    return {
      matcher: {
        sourceText,
        ignored: false,
        test: (candidate) =>
          candidate !== undefined && alternatives.has(candidate),
      },
    };
  }
  try {
    const regex = new RegExp(sourceText, "u");
    return {
      matcher: {
        sourceText,
        ignored: false,
        test: (candidate) => candidate !== undefined && regex.test(candidate),
      },
    };
  } catch (error) {
    return {
      diagnostic: {
        code: "hook_matcher_regex_invalid",
        severity: "error",
        message: `Invalid hook matcher regex: ${errorMessage(error)}`,
      },
    };
  }
}

function parseHandler(value: unknown): {
  handler?: HookHandler;
  unsupported?: boolean;
  code?: string;
  message: string;
} {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { message: "Hook handler must be an object with a string 'type'." };
  }
  if (value.type === "command") {
    if (typeof value.command !== "string" || value.command.length === 0) {
      return {
        message: "Command hook handler requires a non-empty 'command'.",
      };
    }
    if (
      value.commandWindows !== undefined &&
      typeof value.commandWindows !== "string"
    ) {
      return { message: "Command hook 'commandWindows' must be a string." };
    }
    if (
      value.timeout !== undefined &&
      (typeof value.timeout !== "number" ||
        !Number.isFinite(value.timeout) ||
        value.timeout <= 0)
    ) {
      return {
        message: "Command hook 'timeout' must be a positive number of seconds.",
      };
    }
    if (value.async !== undefined && typeof value.async !== "boolean") {
      return { message: "Command hook 'async' must be boolean." };
    }
    const handler: CommandHookHandler = {
      type: "command",
      command: value.command,
      ...(typeof value.commandWindows === "string"
        ? { commandWindows: value.commandWindows }
        : {}),
      ...(typeof value.timeout === "number"
        ? { timeoutSeconds: value.timeout }
        : {}),
      async: value.async === true,
    };
    return { handler, message: "" };
  }
  if (
    value.type === "mcp_tool" ||
    value.type === "prompt" ||
    value.type === "agent"
  ) {
    return {
      handler: { type: value.type, configuration: { ...value } },
      unsupported: true,
      message: "",
    };
  }
  return {
    code: "hook_handler_type_unknown",
    message: `Unknown hook handler type '${value.type}' was ignored.`,
  };
}

function invalidShape(
  sourceId: string,
  event: HookEventName,
  jsonPath: string,
  message: string,
): HookDiagnostic {
  return {
    code: "hook_configuration_invalid",
    severity: "error",
    message,
    sourceId,
    event,
    jsonPath,
  };
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
