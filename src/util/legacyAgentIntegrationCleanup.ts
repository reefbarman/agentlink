import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

import { parseJsonWithComments } from "@agentlink/protocol/jsonc";

export const LEGACY_AGENT_INTEGRATION_CLEANUP_STATE_KEY =
  "legacyAgentIntegrationCleanup.v1";

const AGENTLINK_BEGIN_MARKER = "<!-- BEGIN agentlink -->";
const AGENTLINK_END_MARKER = "<!-- END agentlink -->";
const CODEX_SECTION_HEADER = "[mcp_servers.agentlink]";
const AGENTLINK_HOOK_MATCHER = "^(Read|Edit|Write|Bash|Glob|Grep)$";
const HOOK_SCRIPT_NAMES = ["enforce-agentlink.sh", "enforce-agentlink.ps1"];
const WORKSPACE_JSON_CONFIGS = [
  { relativePath: ".mcp.json", containerKey: "mcpServers" },
  { relativePath: ".vscode/mcp.json", containerKey: "servers" },
  { relativePath: ".roo/mcp.json", containerKey: "mcpServers" },
  { relativePath: ".kilocode/mcp.json", containerKey: "mcpServers" },
] as const;
const WORKSPACE_INSTRUCTION_PATHS = [
  ".github/copilot-instructions.md",
  ".roo/rules/agentlink.md",
  ".clinerules",
  ".kilocode/rules/agentlink.md",
  "AGENTS.md",
] as const;

export interface LegacyCleanupState {
  version: 1;
  completedTargets: string[];
}

export interface LegacyCleanupStateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

export interface LegacyCleanupOptions {
  homeDir: string;
  workspaceRoots: string[];
  state?: LegacyCleanupStateStore;
  log?: (message: string) => void;
}

export interface LegacyCleanupFailure {
  target: string;
  error: string;
}

export interface LegacyCleanupReport {
  changedTargets: string[];
  completedTargets: string[];
  failures: LegacyCleanupFailure[];
}

interface CleanupTarget {
  id: string;
  run: () => boolean;
}

interface PropertyRange {
  key: string;
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
}

interface CompositeRange {
  start: number;
  end: number;
  kind: "object" | "array";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFormerAgentLinkServer(value: unknown): boolean {
  if (!isRecord(value) || typeof value.url !== "string") return false;
  try {
    const url = new URL(value.url);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "http:" &&
      (hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "[::1]" ||
        hostname === "::1") &&
      /^\/mcp\/?$/.test(url.pathname) &&
      !!url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function skipTrivia(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    if (/\s/.test(text[index] ?? "")) {
      index++;
      continue;
    }
    if (text[index] === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && !/[\r\n]/.test(text[index] ?? "")) index++;
      continue;
    }
    if (text[index] === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      return end < 0 ? text.length : skipTrivia(text, end + 2);
    }
    break;
  }
  return index;
}

function previousSignificantIndex(text: string, from: number): number {
  let index = from;
  while (index >= 0 && /\s/.test(text[index] ?? "")) index--;
  return index;
}

function scanStringEnd(text: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      return index + 1;
    }
  }
  throw new Error("unterminated_json_string");
}

function scanCompositeEnd(text: string, start: number): number {
  const stack: string[] = [text[start] === "{" ? "}" : "]"];
  let index = start + 1;
  while (index < text.length && stack.length > 0) {
    const char = text[index];
    if (char === '"') {
      index = scanStringEnd(text, index);
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && !/[\r\n]/.test(text[index] ?? "")) index++;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) throw new Error("unterminated_json_comment");
      index = end + 2;
      continue;
    }
    if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === stack.at(-1)) stack.pop();
    index++;
  }
  if (stack.length > 0) throw new Error("unterminated_json_value");
  return index;
}

function scanValueEnd(text: string, start: number): number {
  const char = text[start];
  if (char === '"') return scanStringEnd(text, start);
  if (char === "{" || char === "[") return scanCompositeEnd(text, start);
  let index = start;
  while (index < text.length && !/[},\]]/.test(text[index] ?? "")) index++;
  return index;
}

function collectNamedPropertyRanges(
  text: string,
  propertyName: string | undefined,
  requiredDepth?: number,
): PropertyRange[] {
  const ranges: PropertyRange[] = [];
  const stack: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && !/[\r\n]/.test(text[index] ?? "")) index++;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) throw new Error("unterminated_json_comment");
      index = end + 2;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      index++;
      continue;
    }
    if (char === stack.at(-1)) {
      stack.pop();
      index++;
      continue;
    }
    if (char !== '"') {
      index++;
      continue;
    }
    const stringEnd = scanStringEnd(text, index);
    const key = JSON.parse(text.slice(index, stringEnd)) as string;
    const colon = skipTrivia(text, stringEnd);
    if (
      (propertyName !== undefined && key !== propertyName) ||
      text[colon] !== ":" ||
      (requiredDepth !== undefined && stack.length !== requiredDepth)
    ) {
      index = stringEnd;
      continue;
    }
    const valueStart = skipTrivia(text, colon + 1);
    const valueEnd = scanValueEnd(text, valueStart);
    ranges.push({ key, start: index, end: valueEnd, valueStart, valueEnd });
    index = valueEnd;
  }
  return ranges;
}

function expandElementRemovalRange(
  text: string,
  start: number,
  end: number,
): [number, number] {
  const next = skipTrivia(text, end);
  if (text[next] === ",") {
    let removalEnd = next + 1;
    while (text[removalEnd] === " " || text[removalEnd] === "\t") removalEnd++;
    return [start, removalEnd];
  }
  const previous = previousSignificantIndex(text, start - 1);
  if (text[previous] === ",") return [previous, end];
  return [start, end];
}

function applyRanges(
  text: string,
  ranges: Array<[number, number, string]>,
): string {
  const normalized: Array<[number, number, string]> = [];
  for (const range of [...ranges].sort((a, b) => a[0] - b[0])) {
    const previous = normalized.at(-1);
    if (!previous || range[0] >= previous[1]) {
      normalized.push([...range]);
      continue;
    }
    if (previous[2] !== "" || range[2] !== "") {
      throw new Error("overlapping_json_edits");
    }
    previous[1] = Math.max(previous[1], range[1]);
  }

  let updated = text;
  for (const [start, end, replacement] of normalized.reverse()) {
    updated = updated.slice(0, start) + replacement + updated.slice(end);
  }
  return updated;
}

function collectPropertyPathRanges(
  text: string,
  pathSegments: readonly string[],
): PropertyRange[] {
  let contexts = [{ text, offset: 0 }];
  for (let index = 0; index < pathSegments.length; index++) {
    const segment = pathSegments[index];
    const last = index === pathSegments.length - 1;
    const nextContexts: Array<{ text: string; offset: number }> = [];
    const matches: PropertyRange[] = [];
    for (const context of contexts) {
      for (const range of collectNamedPropertyRanges(
        context.text,
        segment === "*" ? undefined : segment,
        1,
      )) {
        const absolute = {
          ...range,
          start: context.offset + range.start,
          end: context.offset + range.end,
          valueStart: context.offset + range.valueStart,
          valueEnd: context.offset + range.valueEnd,
        };
        if (last) {
          matches.push(absolute);
        } else if (context.text[range.valueStart] === "{") {
          nextContexts.push({
            text: context.text.slice(range.valueStart, range.valueEnd),
            offset: context.offset + range.valueStart,
          });
        }
      }
    }
    if (last) return matches;
    contexts = nextContexts;
  }
  return [];
}

function removeSignedAgentLinkProperties(
  text: string,
  propertyPaths: readonly (readonly string[])[],
): string {
  parseJsonWithComments(text);
  const removals: Array<[number, number, string]> = [];
  for (const propertyPath of propertyPaths) {
    for (const range of collectPropertyPathRanges(text, propertyPath)) {
      const valueText = text.slice(range.valueStart, range.valueEnd);
      const value = parseJsonWithComments(valueText);
      if (!isFormerAgentLinkServer(value)) continue;
      const [start, end] = expandElementRemovalRange(
        text,
        range.start,
        range.end,
      );
      removals.push([start, end, ""]);
    }
  }
  return applyRanges(text, removals);
}

function collectCompositeRanges(text: string): CompositeRange[] {
  const ranges: CompositeRange[] = [];
  const stack: Array<{
    start: number;
    kind: "object" | "array";
    close: string;
  }> = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      index = scanStringEnd(text, index);
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && !/[\r\n]/.test(text[index] ?? "")) index++;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) throw new Error("unterminated_json_comment");
      index = end + 2;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push({
        start: index,
        kind: char === "{" ? "object" : "array",
        close: char === "{" ? "}" : "]",
      });
    } else if (stack.at(-1)?.close === char) {
      const opened = stack.pop()!;
      ranges.push({ start: opened.start, end: index + 1, kind: opened.kind });
    }
    index++;
  }
  if (stack.length > 0) throw new Error("unterminated_json_value");
  return ranges;
}

function isAgentLinkHookCommand(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.command === "string" &&
    /(?:^|[\\/])enforce-agentlink\.(?:sh|ps1)(?:["']|\s|$)/i.test(value.command)
  );
}

function removeHookObjectsFromPreToolUse(text: string): string {
  const removals: Array<[number, number, string]> = [];
  for (const preToolUse of collectPropertyPathRanges(text, [
    "hooks",
    "PreToolUse",
  ])) {
    if (text[preToolUse.valueStart] !== "[") continue;
    const arrayText = text.slice(preToolUse.valueStart, preToolUse.valueEnd);
    for (const range of collectCompositeRanges(arrayText)) {
      if (range.kind !== "object") continue;
      const parsed = parseJsonWithComments<unknown>(
        arrayText.slice(range.start, range.end),
      );
      if (!isAgentLinkHookCommand(parsed)) continue;
      const [relativeStart, relativeEnd] = expandElementRemovalRange(
        arrayText,
        range.start,
        range.end,
      );
      removals.push([
        preToolUse.valueStart + relativeStart,
        preToolUse.valueStart + relativeEnd,
        "",
      ]);
    }
  }
  return applyRanges(text, removals);
}

function removeEmptyAgentLinkHookEntries(text: string): string {
  const removals: Array<[number, number, string]> = [];
  for (const preToolUse of collectPropertyPathRanges(text, [
    "hooks",
    "PreToolUse",
  ])) {
    if (text[preToolUse.valueStart] !== "[") continue;
    const arrayText = text.slice(preToolUse.valueStart, preToolUse.valueEnd);
    for (const range of collectCompositeRanges(arrayText)) {
      if (range.kind !== "object") continue;
      const parsed = parseJsonWithComments<unknown>(
        arrayText.slice(range.start, range.end),
      );
      if (
        !isRecord(parsed) ||
        parsed.matcher !== AGENTLINK_HOOK_MATCHER ||
        !Array.isArray(parsed.hooks) ||
        parsed.hooks.length > 0
      ) {
        continue;
      }
      const [relativeStart, relativeEnd] = expandElementRemovalRange(
        arrayText,
        range.start,
        range.end,
      );
      removals.push([
        preToolUse.valueStart + relativeStart,
        preToolUse.valueStart + relativeEnd,
        "",
      ]);
    }
  }
  return applyRanges(text, removals);
}

function removeAgentLinkHookEntries(text: string): string {
  parseJsonWithComments(text);
  const withoutCommands = removeHookObjectsFromPreToolUse(text);
  const withoutEmptyEntries = removeEmptyAgentLinkHookEntries(withoutCommands);
  parseJsonWithComments(withoutEmptyEntries);
  return withoutEmptyEntries;
}

function removeAgentLinkInstructionBlock(text: string): string {
  let updated = text;
  while (true) {
    let start = updated.indexOf(AGENTLINK_BEGIN_MARKER);
    if (start < 0) break;
    const markerEnd = updated.indexOf(AGENTLINK_END_MARKER, start);
    if (markerEnd < 0)
      throw new Error("unterminated_agentlink_instruction_block");
    let end = markerEnd + AGENTLINK_END_MARKER.length;
    if (updated[end] === "\r" && updated[end + 1] === "\n") end += 2;
    else if (updated[end] === "\n") end++;

    const beforeLineBreak =
      start >= 2 && updated.slice(start - 2, start) === "\r\n"
        ? 2
        : start >= 1 && updated[start - 1] === "\n"
          ? 1
          : 0;
    const afterLineBreak = updated.slice(end).startsWith("\r\n")
      ? 2
      : updated[end] === "\n"
        ? 1
        : 0;
    if (beforeLineBreak && afterLineBreak) {
      start -= beforeLineBreak;
    }
    updated = updated.slice(0, start) + updated.slice(end);
  }
  return updated;
}

function hasAgentLinkHookScriptSignature(text: string): boolean {
  return (
    /AgentLink MCP equivalents should be used/i.test(text) &&
    /agentlink MCP server provides VS Code-integrated equivalents/i.test(text)
  );
}

function removeSignedCodexSection(text: string): string {
  const lines = text.split(/(?<=\n)/);
  const output: string[] = [];
  let section: string[] | null = null;

  const flush = () => {
    if (!section) return;
    const joined = section.join("");
    if (
      !/url\s*=\s*["']http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+\/mcp\/?["']/i.test(
        joined,
      )
    ) {
      output.push(joined);
    } else if (output.at(-1)?.trim() === "" && output.at(-2)?.trim() === "") {
      output.pop();
    }
    section = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === CODEX_SECTION_HEADER) {
      flush();
      section = [line];
      continue;
    }
    if (section && trimmed.startsWith("[")) flush();
    if (section) section.push(line);
    else output.push(line);
  }
  flush();
  return output.join("");
}

function writeTextFileAtomic(filePath: string, content: string): void {
  const stat = fs.statSync(filePath);
  const tmpPath = `${filePath}.agentlink-cleanup-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: "utf-8", mode: stat.mode });
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

function updateTextFile(
  filePath: string,
  transform: (text: string) => string,
): boolean {
  if (!fs.existsSync(filePath)) return false;
  const before = fs.readFileSync(filePath, "utf-8");
  const after = transform(before);
  if (after === before) return false;
  if (after.trim() === "") fs.rmSync(filePath);
  else writeTextFileAtomic(filePath, after);
  return true;
}

function workspaceTargetPrefix(workspaceRoot: string): string {
  return `workspace:${createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12)}`;
}

function createTargets(options: LegacyCleanupOptions): CleanupTarget[] {
  const { homeDir, workspaceRoots } = options;
  const targets: CleanupTarget[] = [
    {
      id: "claude-config",
      run: () =>
        updateTextFile(path.join(homeDir, ".claude.json"), (text) =>
          removeSignedAgentLinkProperties(text, [
            ["mcpServers", "agentlink"],
            ["projects", "*", "mcpServers", "agentlink"],
          ]),
        ),
    },
    {
      id: "cline-config",
      run: () =>
        updateTextFile(
          path.join(
            homeDir,
            ".cline",
            "data",
            "settings",
            "cline_mcp_settings.json",
          ),
          (text) =>
            removeSignedAgentLinkProperties(text, [
              ["mcpServers", "agentlink"],
            ]),
        ),
    },
    {
      id: "codex-config",
      run: () =>
        updateTextFile(
          path.join(homeDir, ".codex", "config.toml"),
          removeSignedCodexSection,
        ),
    },
    {
      id: "claude-hooks-config",
      run: () =>
        updateTextFile(
          path.join(homeDir, ".claude", "settings.json"),
          removeAgentLinkHookEntries,
        ),
    },
    {
      id: "claude-instructions",
      run: () =>
        updateTextFile(
          path.join(homeDir, ".claude", "CLAUDE.md"),
          removeAgentLinkInstructionBlock,
        ),
    },
  ];

  for (const scriptName of HOOK_SCRIPT_NAMES) {
    targets.push({
      id: `hook-script:${scriptName}`,
      run: () => {
        const scriptPath = path.join(homeDir, ".claude", "hooks", scriptName);
        if (!fs.existsSync(scriptPath)) return false;
        const content = fs.readFileSync(scriptPath, "utf-8");
        if (!hasAgentLinkHookScriptSignature(content)) return false;
        fs.rmSync(scriptPath);
        return true;
      },
    });
  }

  for (const workspaceRoot of workspaceRoots) {
    const prefix = workspaceTargetPrefix(workspaceRoot);
    for (const config of WORKSPACE_JSON_CONFIGS) {
      targets.push({
        id: `${prefix}:config:${config.relativePath}`,
        run: () =>
          updateTextFile(
            path.join(workspaceRoot, config.relativePath),
            (text) =>
              removeSignedAgentLinkProperties(text, [
                [config.containerKey, "agentlink"],
              ]),
          ),
      });
    }
    for (const relativePath of WORKSPACE_INSTRUCTION_PATHS) {
      targets.push({
        id: `${prefix}:instructions:${relativePath}`,
        run: () =>
          updateTextFile(
            path.join(workspaceRoot, relativePath),
            removeAgentLinkInstructionBlock,
          ),
      });
    }
  }
  return targets;
}

export async function runLegacyAgentIntegrationCleanup(
  options: LegacyCleanupOptions,
): Promise<LegacyCleanupReport> {
  const log = options.log ?? (() => {});
  const previous = options.state?.get<LegacyCleanupState>(
    LEGACY_AGENT_INTEGRATION_CLEANUP_STATE_KEY,
  );
  const completed = new Set(
    previous?.version === 1 ? previous.completedTargets : [],
  );
  const report: LegacyCleanupReport = {
    changedTargets: [],
    completedTargets: [],
    failures: [],
  };

  for (const target of createTargets(options)) {
    if (completed.has(target.id)) continue;
    try {
      if (target.run()) report.changedTargets.push(target.id);
      const nextCompleted = new Set(completed).add(target.id);
      await options.state?.update(LEGACY_AGENT_INTEGRATION_CLEANUP_STATE_KEY, {
        version: 1,
        completedTargets: [...nextCompleted],
      } satisfies LegacyCleanupState);
      completed.add(target.id);
      report.completedTargets.push(target.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failures.push({ target: target.id, error: message });
      log(`Legacy AgentLink cleanup failed for ${target.id}: ${message}`);
    }
  }

  return report;
}
