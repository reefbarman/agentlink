import * as os from "os";
import * as fs from "fs/promises";
import * as path from "path";

export interface McpServerConfig {
  /** Unique server name (key from config file) */
  name: string;
  /** stdio transport */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** sse or streamable-http transport ("http" is an alias for "streamable-http") */
  type?: "stdio" | "sse" | "streamable-http" | "http";
  url?: string;
  /** Per-server timeout in ms (default 60000) */
  timeout?: number;
  /** HTTP headers for SSE/streamable-http transports (e.g. Authorization) */
  headers?: Record<string, string>;
  /**
   * Tool approval policy for this server.
   * "ask" (default) — prompt before each new tool.
   * "allow"         — auto-approve all tools without prompting.
   */
  toolPolicy?: "ask" | "allow";
  /**
   * Tools that are always auto-approved regardless of toolPolicy.
   * Use the bare tool name (without server prefix), e.g. "search_issues".
   */
  allowedTools?: string[];
}

interface McpConfigFile {
  mcpServers?: Record<
    string,
    Omit<McpServerConfig, "name"> & { type?: string }
  >;
}

async function safeReadJson(filePath: string): Promise<McpConfigFile | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as McpConfigFile;
  } catch {
    return null;
  }
}

function resolveEnvVars(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    // Interpolate ${VAR} references from process.env
    resolved[key] = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
      return process.env[name] ?? "";
    });
  }
  return resolved;
}

/**
 * Load and merge MCP server configs from all sources.
 *
 * Priority (later entries override earlier for the same server name):
 *   .agents → .claude → .agentlink, global → project
 *
 * 1. ~/.agents/mcp.json       (global, lowest)
 * 2. ~/.claude/mcp.json        (global)
 * 3. ~/.agentlink/mcp.json     (global)
 * 4. <cwd>/.agents/mcp.json    (project)
 * 5. <cwd>/.claude/mcp.json    (project)
 * 6. <cwd>/.agentlink/mcp.json (project, highest)
 */
export async function loadMcpConfigs(cwd: string): Promise<McpServerConfig[]> {
  const home = os.homedir();
  const sources = [
    path.join(home, ".agents", "mcp.json"),
    path.join(home, ".claude", "mcp.json"),
    path.join(home, ".agentlink", "mcp.json"),
    path.join(cwd, ".agents", "mcp.json"),
    path.join(cwd, ".claude", "mcp.json"),
    path.join(cwd, ".agentlink", "mcp.json"),
  ];

  const merged = new Map<string, McpServerConfig>();

  for (const filePath of sources) {
    const config = await safeReadJson(filePath);
    if (!config?.mcpServers) continue;

    for (const [name, raw] of Object.entries(config.mcpServers)) {
      const entry = raw as McpServerConfig & {
        toolPolicy?: string;
        allowedTools?: string[];
      };
      const existing = merged.get(name);

      // Patch merge: only override fields that are explicitly set in this source.
      // This allows a project mcp.json to set just toolPolicy/allowedTools
      // without having to repeat the full server connection config.
      const next: McpServerConfig = {
        // Start from existing (lower-priority source) or defaults
        name,
        type: existing?.type ?? "stdio",
        command: existing?.command,
        args: existing?.args,
        env: existing?.env,
        url: existing?.url,
        timeout: existing?.timeout,
        headers: existing?.headers,
        toolPolicy: existing?.toolPolicy ?? "ask",
        allowedTools: existing?.allowedTools,
      };

      // Apply each field only if explicitly present in this source
      if (raw.type !== undefined)
        next.type = raw.type as McpServerConfig["type"];
      if (raw.command !== undefined) next.command = raw.command;
      if (raw.args !== undefined) next.args = raw.args;
      if (raw.env !== undefined) next.env = resolveEnvVars(raw.env);
      if (raw.url !== undefined) next.url = raw.url;
      if (raw.timeout !== undefined) next.timeout = raw.timeout;
      if (raw.headers !== undefined) next.headers = raw.headers;
      if (entry.toolPolicy !== undefined)
        next.toolPolicy = entry.toolPolicy === "allow" ? "allow" : "ask";
      if (Array.isArray(entry.allowedTools)) {
        // Merge allowedTools — union of existing + new entries
        const existing_ = next.allowedTools ?? [];
        const merged_ = [...existing_, ...entry.allowedTools].filter(
          (v, i, a) => a.indexOf(v) === i,
        );
        next.allowedTools = merged_.length > 0 ? merged_ : undefined;
      }

      merged.set(name, next);
    }
  }

  return Array.from(merged.values());
}

/** Paths to watch for MCP config changes */
export function getMcpConfigPaths(cwd: string): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".agents", "mcp.json"),
    path.join(home, ".claude", "mcp.json"),
    path.join(home, ".agentlink", "mcp.json"),
    path.join(cwd, ".agents", "mcp.json"),
    path.join(cwd, ".claude", "mcp.json"),
    path.join(cwd, ".agentlink", "mcp.json"),
  ];
}

/**
 * Persist a specific tool approval to the given mcp.json file.
 * Adds `bareToolName` to the server's `allowedTools` array.
 */
export async function persistMcpToolApproval(
  serverName: string,
  bareToolName: string,
  filePath: string,
): Promise<void> {
  await patchMcpJson(filePath, serverName, (entry) => {
    const tools = (entry.allowedTools as string[] | undefined) ?? [];
    if (!tools.includes(bareToolName)) {
      entry.allowedTools = [...tools, bareToolName];
    }
  });
}

/**
 * Persist a full server approval to the given mcp.json file.
 * Sets `toolPolicy: "allow"` for the server.
 */
export async function persistMcpServerApproval(
  serverName: string,
  filePath: string,
): Promise<void> {
  await patchMcpJson(filePath, serverName, (entry) => {
    entry.toolPolicy = "allow";
  });
}

/** Read–modify–write a single server entry in a mcp.json file. */
async function patchMcpJson(
  filePath: string,
  serverName: string,
  mutate: (entry: Record<string, unknown>) => void,
): Promise<void> {
  // Ensure directory exists
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // Read existing file (or start fresh)
  let doc: { mcpServers?: Record<string, Record<string, unknown>> } = {};
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    doc = JSON.parse(raw);
  } catch {
    // File doesn't exist or invalid — start fresh
  }

  if (!doc.mcpServers) doc.mcpServers = {};
  const entry = doc.mcpServers[serverName] ?? {};
  mutate(entry);
  doc.mcpServers[serverName] = entry;

  // Atomic write via temp file
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, filePath);
}

/** Returns the project and global MCP config file paths */
export function getMcpConfigFilePaths(cwd: string): {
  project: string;
  global: string;
} {
  const home = os.homedir();
  return {
    project: path.join(cwd, ".agentlink", "mcp.json"),
    global: path.join(home, ".agentlink", "mcp.json"),
  };
}
