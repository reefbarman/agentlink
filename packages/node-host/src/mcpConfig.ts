import { promises as fs } from "node:fs";
import os from "node:os";
import { parseJsonWithComments } from "@agentlink/protocol/jsonc";
import path from "node:path";

export type McpConfigProvenance =
  | {
      readonly kind: "native";
      readonly sourceServerName: string;
      readonly sourceProjectIds: readonly string[];
      readonly sourceProjectRoots: readonly string[];
    }
  | {
      readonly kind: "agent-plugin";
      readonly scope:
        | { readonly kind: "global" }
        | { readonly kind: "project"; readonly projectId: string };
      readonly installInstanceId: string;
      readonly packageDigest: string;
      readonly portableServerName: string;
      readonly runtimeServerName: string;
    };

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "stdio" | "sse" | "streamable-http" | "http";
  url?: string;
  timeout?: number;
  headers?: Record<string, string>;
  toolPolicy?: "ask" | "allow";
  toolDisclosure?: "inline" | "deferred" | "auto";
  supportsParallelToolCalls?: boolean;
  allowedTools?: string[];
  disabled?: boolean;
  sourceServerName?: string;
  sourceProjectIds?: string[];
  sourceProjectRoots?: string[];
  cwd?: string;
  provenance?: McpConfigProvenance;
  pluginRoot?: string;
  pluginData?: string;
}

export interface WorkspaceMcpProject {
  projectId: string;
  displayName: string;
  rootPath: string;
}

interface McpConfigFile {
  mcpServers?: Record<
    string,
    Omit<McpServerConfig, "name"> & { type?: string }
  >;
}

export type McpConfigReadResult =
  | { status: "available"; config: McpConfigFile; raw: string }
  | { status: "missing" }
  | {
      status: "invalid" | "unreadable";
      error: "invalid_json" | "permission_denied" | "read_failed";
      raw?: string;
    };

export function isMcpConfigDocument(value: unknown): value is McpConfigFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if ("mcpServers" in value && "servers" in value) return false;
  const servers = (value as McpConfigFile).mcpServers;
  return (
    servers === undefined ||
    (typeof servers === "object" &&
      servers !== null &&
      !Array.isArray(servers) &&
      Object.values(servers).every(
        (entry) =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      ))
  );
}

export async function readMcpConfig(
  filePath: string,
): Promise<McpConfigReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;
    if (code === "ENOENT") return { status: "missing" };
    return {
      status: "unreadable",
      error:
        code === "EACCES" || code === "EPERM"
          ? "permission_denied"
          : "read_failed",
    };
  }

  try {
    const config = parseJsonWithComments<unknown>(raw);
    if (!isMcpConfigDocument(config)) {
      return { status: "invalid", error: "invalid_json", raw };
    }
    return { status: "available", config, raw };
  } catch {
    return { status: "invalid", error: "invalid_json", raw };
  }
}

export function globalMcpConfigSources(home = os.homedir()): string[] {
  return [".agents", ".claude", ".agentlink"].map((directory) =>
    path.join(home, directory, "mcp.json"),
  );
}

export function projectMcpConfigSources(projectRoot: string): string[] {
  return [".agents", ".claude", ".agentlink"].map((directory) =>
    path.join(projectRoot, directory, "mcp.json"),
  );
}

export function askAgentMcpConfigSources(home = os.homedir()): string[] {
  return [
    ...globalMcpConfigSources(home),
    path.join(home, ".agentlink", "ask-agent", "mcp.json"),
  ];
}

export async function loadMcpConfigsFromSources(
  sources: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  project?: { readonly root: string; readonly sources: readonly string[] },
): Promise<McpServerConfig[]> {
  const merged = new Map<string, McpServerConfig>();
  const canonical = async (filePath: string) =>
    await fs.realpath(filePath).catch(() => path.resolve(filePath));
  const globalSourceCount = project
    ? sources.length - project.sources.length
    : sources.length;
  const globalSources = new Set(
    await Promise.all(sources.slice(0, globalSourceCount).map(canonical)),
  );
  const seen = new Set<string>();
  for (const [index, filePath] of sources.entries()) {
    const canonicalPath = await canonical(filePath);
    if (seen.has(canonicalPath)) continue;
    seen.add(canonicalPath);
    const projectSource =
      project &&
      index >= globalSourceCount &&
      !globalSources.has(canonicalPath);
    const read = await readMcpConfig(filePath);
    if (read.status !== "available" || !read.config?.mcpServers) continue;

    for (const [name, raw] of Object.entries(read.config.mcpServers)) {
      const existing = merged.get(name);
      const next: McpServerConfig = {
        name,
        type: existing?.type ?? "stdio",
        command: existing?.command,
        args: existing?.args,
        env: existing?.env,
        url: existing?.url,
        timeout: existing?.timeout,
        headers: existing?.headers,
        toolPolicy: existing?.toolPolicy ?? "ask",
        toolDisclosure: existing?.toolDisclosure ?? "auto",
        supportsParallelToolCalls: existing?.supportsParallelToolCalls ?? false,
        allowedTools: existing?.allowedTools,
        disabled: existing?.disabled ?? false,
      };
      if (raw.type !== undefined)
        next.type = raw.type as McpServerConfig["type"];
      if (raw.command !== undefined) next.command = raw.command;
      if (raw.args !== undefined) next.args = raw.args;
      if (raw.env !== undefined)
        next.env = resolveConfigVars(raw.env, environment);
      if (raw.url !== undefined) next.url = raw.url;
      if (raw.timeout !== undefined) next.timeout = raw.timeout;
      if (raw.headers !== undefined)
        next.headers = resolveConfigVars(raw.headers, environment);
      if (raw.toolPolicy !== undefined)
        next.toolPolicy = raw.toolPolicy === "allow" ? "allow" : "ask";
      if (raw.toolDisclosure !== undefined) {
        next.toolDisclosure =
          raw.toolDisclosure === "inline" ||
          raw.toolDisclosure === "deferred" ||
          raw.toolDisclosure === "auto"
            ? raw.toolDisclosure
            : "auto";
      }
      if (raw.supportsParallelToolCalls !== undefined) {
        next.supportsParallelToolCalls = raw.supportsParallelToolCalls === true;
      }
      if (raw.disabled !== undefined) next.disabled = raw.disabled === true;
      if (Array.isArray(raw.allowedTools)) {
        next.allowedTools = [...raw.allowedTools];
      }
      if (projectSource) {
        next.sourceServerName = name;
        next.sourceProjectRoots = [project.root];
        next.provenance = {
          kind: "native",
          sourceServerName: name,
          sourceProjectIds: [],
          sourceProjectRoots: [project.root],
        };
      }
      merged.set(name, next);
    }
  }
  return Array.from(merged.values());
}

function resolveConfigVars(
  values: Record<string, string> | undefined,
  environment: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!values) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    resolved[key] = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
      return environment[name] ?? "";
    });
  }
  return resolved;
}
