import type { McpServerConfig } from "./mcpConfig.js";
import { stripVTControlCharacters } from "node:util";

function isSensitiveName(name: string): boolean {
  return /token|secret|password|passwd|credential|authorization|cookie|session|api.?key|private.?key|(?:^|[_-])(?:key|pat|dsn)(?:$|[_-])/i.test(
    name,
  );
}

function argumentSecrets(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) continue;
    const separator = argument.indexOf("=");
    const flag = separator < 0 ? argument : argument.slice(0, separator);
    if (flag !== "--header" && !isSensitiveName(flag)) continue;
    const value =
      separator < 0 ? args[index + 1] : argument.slice(separator + 1);
    if (!value || value.startsWith("--")) continue;
    if (flag === "--header") {
      const headerValue = value.slice(value.indexOf(":") + 1).trim();
      values.push(headerValue, headerValue.replace(/^Bearer\s+/i, ""));
    } else values.push(value);
  }
  return values;
}

/** Process output is untrusted and can contain OAuth URLs or credentials. */
export function mcpStartupDiagnostic(
  message: string,
  stderr: string,
  config: Readonly<McpServerConfig>,
  environment?: Readonly<Record<string, string>>,
): string {
  let diagnostic = stripVTControlCharacters(
    [message, stderr.trim() ? `Process stderr:\n${stderr.trim()}` : ""]
      .filter(Boolean)
      .join("\n"),
  );
  const sensitiveValues = [
    ...Object.entries({ ...config.env, ...environment })
      .filter(([key]) => isSensitiveName(key))
      .map(([, value]) => value),
    ...Object.values(config.headers ?? {}).flatMap((value) => [
      value,
      value.replace(/^Bearer\s+/i, ""),
    ]),
    ...argumentSecrets(config.args ?? []),
  ]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const value of sensitiveValues) {
    diagnostic = diagnostic.split(value).join("[redacted]");
  }
  return diagnostic
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/gi, "[URL redacted]")
    .replace(/\bBearer\s+[^\s,"']+/gi, "Bearer [redacted]")
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|id[_-]?token|password|api[_-]?key|authorization|code)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi,
      "$1[redacted]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g,
      "[redacted]",
    )
    .slice(0, 8192);
}
