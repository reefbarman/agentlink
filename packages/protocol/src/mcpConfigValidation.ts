import type {
  McpManagerServerDraft,
  McpManagerServerWriteDraft,
} from "./mcpManager.js";

export type McpCanonicalTransport = "stdio" | "http" | "sse";

export type McpToolPolicy = "ask" | "allow";

export type McpToolDisclosure = "inline" | "deferred" | "auto";

export interface McpCanonicalServerDraft extends Omit<
  McpManagerServerDraft,
  "type"
> {
  type: McpCanonicalTransport;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export function canonicalDraftToWriteDraft(
  draft: McpCanonicalServerDraft,
): McpManagerServerWriteDraft {
  const { env, headers, ...server } = draft;
  return {
    ...server,
    ...(env ? { env: { mode: "replace", set: env } } : {}),
    ...(headers ? { headers: { mode: "replace", set: headers } } : {}),
  };
}

export type McpConfigDiagnosticSeverity = "info" | "warning" | "error";

export type McpConfigDiagnosticCode =
  | "server_url_alias"
  | "name_normalized"
  | "transport_inferred"
  | "transport_normalized"
  | "legacy_sse_transport"
  | "unknown_field"
  | "invalid_json"
  | "invalid_fence"
  | "invalid_root"
  | "no_servers"
  | "duplicate_server_name"
  | "unknown_root_field"
  | "invalid_server_name"
  | "invalid_server_config"
  | "duplicate_endpoint"
  | "conflicting_endpoints"
  | "missing_endpoint"
  | "command_required"
  | "url_required"
  | "invalid_transport"
  | "invalid_command"
  | "invalid_args"
  | "invalid_env"
  | "invalid_headers"
  | "invalid_record_key"
  | "invalid_url"
  | "url_userinfo_not_allowed"
  | "invalid_timeout"
  | "invalid_tool_policy"
  | "invalid_tool_disclosure"
  | "invalid_parallel_tool_calls"
  | "invalid_allowed_tools"
  | "invalid_disabled";

export interface McpConfigDiagnostic {
  severity: McpConfigDiagnosticSeverity;
  code: McpConfigDiagnosticCode;
  path: string;
  message: string;
}

export interface McpServerValidationReview {
  valid: boolean;
  draft?: McpCanonicalServerDraft;
  diagnostics: McpConfigDiagnostic[];
}

export interface McpServerValidationOptions {
  path?: string;
  namePath?: string;
  warnUnknownFields?: boolean;
}

const BLOCKED_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
  ".",
  "..",
]);

const SUPPORTED_FIELDS = new Set([
  "name",
  "type",
  "disabled",
  "command",
  "args",
  "env",
  "url",
  "serverUrl",
  "headers",
  "timeout",
  "toolPolicy",
  "toolDisclosure",
  "supportsParallelToolCalls",
  "allowedTools",
]);

function diagnostic(
  severity: McpConfigDiagnosticSeverity,
  code: McpConfigDiagnosticCode,
  path: string,
  message: string,
): McpConfigDiagnostic {
  return { severity, code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fieldPath(base: string, field: string): string {
  return base === "$" ? `$.${field}` : `${base}.${field}`;
}

function validateName(
  value: unknown,
  path: string,
  diagnostics: McpConfigDiagnostic[],
): string | undefined {
  if (typeof value !== "string") {
    diagnostics.push(
      diagnostic(
        "error",
        "invalid_server_name",
        path,
        "Server name must be a string using letters, numbers, underscores, dots, or hyphens.",
      ),
    );
    return undefined;
  }

  const name = value.trim();
  if (
    !name ||
    !/^[\w.-]+$/.test(name) ||
    BLOCKED_NAMES.has(name.toLowerCase())
  ) {
    diagnostics.push(
      diagnostic(
        "error",
        "invalid_server_name",
        path,
        "Server name is empty, reserved, or contains unsupported characters.",
      ),
    );
    return undefined;
  }

  if (name !== value) {
    diagnostics.push(
      diagnostic(
        "info",
        "name_normalized",
        path,
        "Leading or trailing whitespace was removed from the server name.",
      ),
    );
  }
  return name;
}

function validateStringArray(
  value: unknown,
  path: string,
  code: "invalid_args" | "invalid_allowed_tools",
  diagnostics: McpConfigDiagnostic[],
): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    diagnostics.push(
      diagnostic(
        "error",
        code,
        path,
        "This field must be an array containing only strings.",
      ),
    );
    return undefined;
  }
  return [...value];
}

function validateStringRecord(
  value: unknown,
  path: string,
  code: "invalid_env" | "invalid_headers",
  diagnostics: McpConfigDiagnostic[],
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(
        "error",
        code,
        path,
        "This field must be an object with string keys and string values.",
      ),
    );
    return undefined;
  }

  const result: Record<string, string> = {};
  let valid = true;
  for (const [key, entry] of Object.entries(value)) {
    if (!key || BLOCKED_NAMES.has(key.toLowerCase())) {
      diagnostics.push(
        diagnostic(
          "error",
          "invalid_record_key",
          path,
          "This record contains an empty or reserved key.",
        ),
      );
      valid = false;
      continue;
    }
    if (typeof entry !== "string") {
      diagnostics.push(
        diagnostic(
          "error",
          code,
          fieldPath(path, key),
          "This record value must be a string.",
        ),
      );
      valid = false;
      continue;
    }
    result[key] = entry;
  }
  return valid ? result : undefined;
}

function validateUrl(
  value: unknown,
  path: string,
  diagnostics: McpConfigDiagnostic[],
): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    diagnostics.push(
      diagnostic(
        "error",
        "invalid_url",
        path,
        "URL must be a non-empty HTTP or HTTPS URL.",
      ),
    );
    return undefined;
  }

  const url = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    diagnostics.push(
      diagnostic(
        "error",
        "invalid_url",
        path,
        "URL must be a valid HTTP or HTTPS URL.",
      ),
    );
    return undefined;
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname
  ) {
    diagnostics.push(
      diagnostic(
        "error",
        "invalid_url",
        path,
        "URL must use HTTP or HTTPS and include a host.",
      ),
    );
    return undefined;
  }
  if (parsed.username || parsed.password) {
    diagnostics.push(
      diagnostic(
        "error",
        "url_userinfo_not_allowed",
        path,
        "Credentials in URL userinfo are not allowed.",
      ),
    );
    return undefined;
  }
  return url;
}

function validateTransport(
  value: unknown,
  path: string,
  diagnostics: McpConfigDiagnostic[],
): McpCanonicalTransport | undefined {
  if (value === "stdio") return "stdio";
  if (value === "http") return "http";
  if (value === "streamable-http") {
    diagnostics.push(
      diagnostic(
        "info",
        "transport_normalized",
        path,
        'Transport "streamable-http" was normalized to "http".',
      ),
    );
    return "http";
  }
  if (value === "sse") {
    diagnostics.push(
      diagnostic(
        "warning",
        "legacy_sse_transport",
        path,
        "SSE is a legacy transport and may not be supported by newer servers.",
      ),
    );
    return "sse";
  }

  diagnostics.push(
    diagnostic(
      "error",
      "invalid_transport",
      path,
      'Transport must be "stdio", "http", "streamable-http", or "sse".',
    ),
  );
  return undefined;
}

/**
 * Canonically validates one MCP server object. The returned diagnostics use
 * static summaries and never interpolate env or header values.
 */
export function validateMcpServerConfig(
  nameValue: unknown,
  configValue: unknown,
  options: McpServerValidationOptions = {},
): McpServerValidationReview {
  const path = options.path ?? "$";
  const namePath = options.namePath ?? fieldPath(path, "name");
  const diagnostics: McpConfigDiagnostic[] = [];
  const name = validateName(nameValue, namePath, diagnostics);

  if (!isRecord(configValue)) {
    diagnostics.push(
      diagnostic(
        "error",
        "invalid_server_config",
        path,
        "Server configuration must be an object.",
      ),
    );
    return { valid: false, diagnostics };
  }

  if (options.warnUnknownFields !== false) {
    for (const key of Object.keys(configValue)) {
      if (!SUPPORTED_FIELDS.has(key)) {
        diagnostics.push(
          diagnostic(
            "warning",
            "unknown_field",
            fieldPath(path, key),
            "Unsupported field was not imported.",
          ),
        );
      }
    }
  }

  const hasCommand =
    hasOwn(configValue, "command") && configValue.command !== undefined;
  const hasUrl = hasOwn(configValue, "url") && configValue.url !== undefined;
  const hasServerUrl =
    hasOwn(configValue, "serverUrl") && configValue.serverUrl !== undefined;

  if (hasUrl && hasServerUrl) {
    diagnostics.push(
      diagnostic(
        "error",
        "duplicate_endpoint",
        fieldPath(path, "url"),
        "Specify only one of url or serverUrl.",
      ),
    );
  } else if (hasServerUrl) {
    diagnostics.push(
      diagnostic(
        "info",
        "server_url_alias",
        fieldPath(path, "serverUrl"),
        "serverUrl was normalized to url.",
      ),
    );
  }

  const hasAnyUrl = hasUrl || hasServerUrl;
  if (hasCommand && hasAnyUrl) {
    diagnostics.push(
      diagnostic(
        "error",
        "conflicting_endpoints",
        path,
        "A server cannot specify both command and URL endpoints.",
      ),
    );
  }

  let type: McpCanonicalTransport | undefined;
  if (configValue.type === undefined) {
    if (hasCommand !== hasAnyUrl) {
      type = hasCommand ? "stdio" : "http";
      diagnostics.push(
        diagnostic(
          "info",
          "transport_inferred",
          fieldPath(path, "type"),
          "Transport was inferred from the configured endpoint.",
        ),
      );
    } else if (!hasCommand && !hasAnyUrl) {
      diagnostics.push(
        diagnostic(
          "error",
          "missing_endpoint",
          path,
          "Server must specify exactly one command or URL endpoint.",
        ),
      );
    }
  } else {
    type = validateTransport(
      configValue.type,
      fieldPath(path, "type"),
      diagnostics,
    );
  }

  let command: string | undefined;
  if (hasCommand) {
    if (
      typeof configValue.command !== "string" ||
      !configValue.command.trim()
    ) {
      diagnostics.push(
        diagnostic(
          "error",
          "invalid_command",
          fieldPath(path, "command"),
          "Command must be a non-empty string.",
        ),
      );
    } else {
      command = configValue.command.trim();
    }
  }

  const endpointValue = hasUrl ? configValue.url : configValue.serverUrl;
  const endpointPath = fieldPath(path, hasUrl ? "url" : "serverUrl");
  const url = hasAnyUrl
    ? validateUrl(endpointValue, endpointPath, diagnostics)
    : undefined;

  if (type === "stdio" && !hasCommand) {
    diagnostics.push(
      diagnostic(
        "error",
        "command_required",
        fieldPath(path, "command"),
        "Stdio transport requires a command.",
      ),
    );
  }
  if ((type === "http" || type === "sse") && !hasAnyUrl) {
    diagnostics.push(
      diagnostic(
        "error",
        "url_required",
        fieldPath(path, "url"),
        "HTTP and SSE transports require a URL.",
      ),
    );
  }

  const draft: Partial<McpCanonicalServerDraft> = {};
  if (name !== undefined) draft.name = name;
  if (type !== undefined) draft.type = type;
  if (command !== undefined) draft.command = command;
  if (url !== undefined) draft.url = url;

  if (configValue.args !== undefined) {
    const args = validateStringArray(
      configValue.args,
      fieldPath(path, "args"),
      "invalid_args",
      diagnostics,
    );
    if (args !== undefined) draft.args = args;
  }
  if (configValue.allowedTools !== undefined) {
    const allowedTools = validateStringArray(
      configValue.allowedTools,
      fieldPath(path, "allowedTools"),
      "invalid_allowed_tools",
      diagnostics,
    );
    if (allowedTools !== undefined) draft.allowedTools = allowedTools;
  }
  if (configValue.env !== undefined) {
    const env = validateStringRecord(
      configValue.env,
      fieldPath(path, "env"),
      "invalid_env",
      diagnostics,
    );
    if (env !== undefined) draft.env = env;
  }
  if (configValue.headers !== undefined) {
    const headers = validateStringRecord(
      configValue.headers,
      fieldPath(path, "headers"),
      "invalid_headers",
      diagnostics,
    );
    if (headers !== undefined) draft.headers = headers;
  }

  if (configValue.disabled !== undefined) {
    if (typeof configValue.disabled !== "boolean") {
      diagnostics.push(
        diagnostic(
          "error",
          "invalid_disabled",
          fieldPath(path, "disabled"),
          "Disabled must be a boolean.",
        ),
      );
    } else {
      draft.disabled = configValue.disabled;
    }
  }

  if (configValue.timeout !== undefined) {
    if (
      typeof configValue.timeout !== "number" ||
      !Number.isFinite(configValue.timeout) ||
      configValue.timeout <= 0
    ) {
      diagnostics.push(
        diagnostic(
          "error",
          "invalid_timeout",
          fieldPath(path, "timeout"),
          "Timeout must be a finite number greater than zero.",
        ),
      );
    } else {
      draft.timeout = configValue.timeout;
    }
  }

  if (configValue.toolPolicy !== undefined) {
    if (
      configValue.toolPolicy !== "ask" &&
      configValue.toolPolicy !== "allow"
    ) {
      diagnostics.push(
        diagnostic(
          "error",
          "invalid_tool_policy",
          fieldPath(path, "toolPolicy"),
          'Tool policy must be "ask" or "allow".',
        ),
      );
    } else {
      draft.toolPolicy = configValue.toolPolicy;
    }
  }

  if (configValue.toolDisclosure !== undefined) {
    if (
      configValue.toolDisclosure !== "inline" &&
      configValue.toolDisclosure !== "deferred" &&
      configValue.toolDisclosure !== "auto"
    ) {
      diagnostics.push(
        diagnostic(
          "error",
          "invalid_tool_disclosure",
          fieldPath(path, "toolDisclosure"),
          'Tool disclosure must be "inline", "deferred", or "auto".',
        ),
      );
    } else {
      draft.toolDisclosure = configValue.toolDisclosure;
    }
  }

  if (configValue.supportsParallelToolCalls !== undefined) {
    if (typeof configValue.supportsParallelToolCalls !== "boolean") {
      diagnostics.push(
        diagnostic(
          "error",
          "invalid_parallel_tool_calls",
          fieldPath(path, "supportsParallelToolCalls"),
          "Parallel tool call support must be a boolean.",
        ),
      );
    } else {
      draft.supportsParallelToolCalls = configValue.supportsParallelToolCalls;
    }
  }

  const valid = !diagnostics.some((entry) => entry.severity === "error");
  return valid
    ? { valid: true, draft: draft as McpCanonicalServerDraft, diagnostics }
    : { valid: false, diagnostics };
}

/** Validates the named-draft shape used by guided editors and persistence. */
export function validateMcpServerDraft(
  value: unknown,
  options: McpServerValidationOptions = {},
): McpServerValidationReview {
  if (!isRecord(value)) {
    return {
      valid: false,
      diagnostics: [
        diagnostic(
          "error",
          "invalid_server_config",
          options.path ?? "$",
          "Server draft must be an object.",
        ),
      ],
    };
  }
  return validateMcpServerConfig(value.name, value, options);
}
