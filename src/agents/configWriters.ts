import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { AgentDefinition, ConfigWriter } from "./types.js";

const SERVER_NAME = "agentlink";

type LogFn = (msg: string) => void;

// --- Helpers ---

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonFileAtomic(
  filePath: string,
  data: Record<string, unknown>,
  log: LogFn,
): boolean {
  const tmpPath = filePath + ".tmp." + process.pid;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    log(`Warning: Could not write ${filePath}: ${err}`);
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    return false;
  }
}

function buildEntry(
  httpType: string | undefined,
  port: number,
  authToken?: string,
): Record<string, unknown> {
  const url = `http://localhost:${port}/mcp`;
  const entry: Record<string, unknown> = { url };
  if (httpType) {
    entry.type = httpType;
  }
  if (authToken) {
    entry.headers = { Authorization: `Bearer ${authToken}` };
  }
  return entry;
}

// --- Claude Code: ~/.claude.json ---

export function createClaudeJsonWriter(log: LogFn): ConfigWriter {
  const configPath = path.join(os.homedir(), ".claude.json");

  function read(): Record<string, unknown> | null {
    return readJsonFile(configPath);
  }

  function save(config: Record<string, unknown>): boolean {
    return writeJsonFileAtomic(configPath, config, log);
  }

  return {
    write(port, authToken) {
      const config = read();
      if (!config) {
        log(
          "Warning: ~/.claude.json contains malformed JSON — skipping auto-configuration",
        );
        return false;
      }

      if (!config.mcpServers || typeof config.mcpServers !== "object") {
        config.mcpServers = {};
      }
      const mcpServers = config.mcpServers as Record<string, unknown>;

      const entry = buildEntry("http", port, authToken);
      const existing = mcpServers[SERVER_NAME] as
        | Record<string, unknown>
        | undefined;
      if (
        existing &&
        existing.type === "http" &&
        existing.url === entry.url &&
        (!authToken ||
          (existing.headers &&
            (existing.headers as Record<string, string>).Authorization ===
              `Bearer ${authToken}`))
      ) {
        log("~/.claude.json global entry already up to date");
        return true;
      }

      mcpServers[SERVER_NAME] = entry;

      // Also write per-project entries
      const folders = vscode.workspace.workspaceFolders;
      if (folders) {
        if (!config.projects || typeof config.projects !== "object") {
          config.projects = {};
        }
        const projects = config.projects as Record<
          string,
          Record<string, unknown>
        >;
        for (const folder of folders) {
          const folderPath = folder.uri.fsPath;
          if (!projects[folderPath]) projects[folderPath] = {};
          const project = projects[folderPath];
          if (!project.mcpServers || typeof project.mcpServers !== "object") {
            project.mcpServers = {};
          }
          (project.mcpServers as Record<string, unknown>)[SERVER_NAME] = entry;
          log(`Set agentlink for Claude Code project ${folderPath}`);
        }
      }

      if (save(config)) {
        log(`Updated ~/.claude.json with agentlink MCP server (port ${port})`);
        return true;
      }
      return false;
    },

    writeForFolder(folderPath, port, authToken) {
      const config = read();
      if (!config) return;

      if (!config.projects || typeof config.projects !== "object") {
        config.projects = {};
      }
      const projects = config.projects as Record<
        string,
        Record<string, unknown>
      >;
      if (!projects[folderPath]) projects[folderPath] = {};
      const project = projects[folderPath];
      if (!project.mcpServers || typeof project.mcpServers !== "object") {
        project.mcpServers = {};
      }

      (project.mcpServers as Record<string, unknown>)[SERVER_NAME] = buildEntry(
        "http",
        port,
        authToken,
      );
      save(config);
      log(`Set agentlink for Claude Code project ${folderPath}`);
    },

    cleanup() {
      const config = read();
      if (!config) return;

      // Remove global entry
      const mcpServers = config.mcpServers as
        | Record<string, unknown>
        | undefined;
      if (mcpServers && SERVER_NAME in mcpServers) {
        delete mcpServers[SERVER_NAME];
      }

      // Remove per-project entries
      const projects = config.projects as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (projects) {
        const folders = vscode.workspace.workspaceFolders;
        if (folders) {
          for (const folder of folders) {
            const project = projects[folder.uri.fsPath];
            if (!project) continue;
            const projServers = project.mcpServers as
              | Record<string, unknown>
              | undefined;
            if (projServers && SERVER_NAME in projServers) {
              delete projServers[SERVER_NAME];
              log(
                `Removed agentlink from Claude Code project ${folder.uri.fsPath}`,
              );
            }
          }
        }
      }

      save(config);
    },

    cleanupFolder(folderPath) {
      const config = read();
      if (!config) return;

      const projects = config.projects as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (!projects) return;

      const project = projects[folderPath];
      if (!project) return;
      const mcpServers = project.mcpServers as
        | Record<string, unknown>
        | undefined;
      if (!mcpServers || !(SERVER_NAME in mcpServers)) return;

      delete mcpServers[SERVER_NAME];
      save(config);
      log(`Removed agentlink from Claude Code project ${folderPath}`);
    },

    isConfigured() {
      const config = read();
      if (!config) return false;
      const mcpServers = config.mcpServers as
        | Record<string, unknown>
        | undefined;
      return !!mcpServers && SERVER_NAME in mcpServers;
    },
  };
}

// --- Workspace JSON config writers (.vscode/mcp.json, .roo/mcp.json, .kilocode/mcp.json) ---

interface WorkspaceJsonWriterOptions {
  /** Relative path from workspace root, e.g. ".vscode/mcp.json" */
  relativePath: string;
  /** Top-level key in the JSON file — "servers" for Copilot, "mcpServers" for others */
  topLevelKey: string;
  /** HTTP type value — "http", "streamable-http", etc. */
  httpType: string;
  /** Agent name for log messages */
  agentName: string;
}

export function createWorkspaceJsonWriter(
  options: WorkspaceJsonWriterOptions,
  log: LogFn,
): ConfigWriter {
  const { relativePath, topLevelKey, httpType, agentName } = options;

  function getConfigPaths(): string[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return [];
    return folders.map((f) => path.join(f.uri.fsPath, relativePath));
  }

  return {
    write(port, authToken) {
      const paths = getConfigPaths();
      if (paths.length === 0) {
        log(`No workspace folders — skipping ${agentName} config`);
        return false;
      }

      const entry = buildEntry(httpType, port, authToken);
      let anyWritten = false;

      for (const configPath of paths) {
        const config = readJsonFile(configPath) ?? {};
        if (!config[topLevelKey] || typeof config[topLevelKey] !== "object") {
          config[topLevelKey] = {};
        }
        const servers = config[topLevelKey] as Record<string, unknown>;
        servers[SERVER_NAME] = entry;

        if (writeJsonFileAtomic(configPath, config, log)) {
          log(`Updated ${configPath} for ${agentName}`);
          anyWritten = true;
        }
      }

      return anyWritten;
    },

    writeForFolder(folderPath, port, authToken) {
      const configPath = path.join(folderPath, relativePath);
      const config = readJsonFile(configPath) ?? {};
      if (!config[topLevelKey] || typeof config[topLevelKey] !== "object") {
        config[topLevelKey] = {};
      }
      const servers = config[topLevelKey] as Record<string, unknown>;
      servers[SERVER_NAME] = buildEntry(httpType, port, authToken);
      writeJsonFileAtomic(configPath, config, log);
      log(`Set agentlink for ${agentName} in ${folderPath}`);
    },

    cleanup() {
      for (const configPath of getConfigPaths()) {
        const config = readJsonFile(configPath);
        if (!config) continue;
        const servers = config[topLevelKey] as
          | Record<string, unknown>
          | undefined;
        if (!servers || !(SERVER_NAME in servers)) continue;
        delete servers[SERVER_NAME];
        writeJsonFileAtomic(configPath, config, log);
        log(`Removed agentlink from ${configPath} for ${agentName}`);
      }
    },

    cleanupFolder(folderPath) {
      const configPath = path.join(folderPath, relativePath);
      const config = readJsonFile(configPath);
      if (!config) return;
      const servers = config[topLevelKey] as
        | Record<string, unknown>
        | undefined;
      if (!servers || !(SERVER_NAME in servers)) return;
      delete servers[SERVER_NAME];
      writeJsonFileAtomic(configPath, config, log);
      log(`Removed agentlink from ${configPath} for ${agentName}`);
    },

    isConfigured() {
      const paths = getConfigPaths();
      for (const configPath of paths) {
        const config = readJsonFile(configPath);
        if (!config) continue;
        const servers = config[topLevelKey] as
          | Record<string, unknown>
          | undefined;
        if (servers && SERVER_NAME in servers) return true;
      }
      return false;
    },
  };
}

// --- Cline: ~/.cline/data/settings/cline_mcp_settings.json ---

export function createClineSettingsWriter(log: LogFn): ConfigWriter {
  const configPath = path.join(
    os.homedir(),
    ".cline",
    "data",
    "settings",
    "cline_mcp_settings.json",
  );

  function read(): Record<string, unknown> | null {
    return readJsonFile(configPath);
  }

  function save(config: Record<string, unknown>): boolean {
    return writeJsonFileAtomic(configPath, config, log);
  }

  return {
    write(port, authToken) {
      const config = read() ?? {};
      if (!config.mcpServers || typeof config.mcpServers !== "object") {
        config.mcpServers = {};
      }
      const mcpServers = config.mcpServers as Record<string, unknown>;

      // Cline uses url + headers directly (no type field)
      const entry: Record<string, unknown> = {
        url: `http://localhost:${port}/mcp`,
      };
      if (authToken) {
        entry.headers = { Authorization: `Bearer ${authToken}` };
      }

      mcpServers[SERVER_NAME] = entry;

      if (save(config)) {
        log(`Updated ${configPath} with agentlink MCP server (port ${port})`);
        return true;
      }
      return false;
    },

    cleanup() {
      const config = read();
      if (!config) return;
      const mcpServers = config.mcpServers as
        | Record<string, unknown>
        | undefined;
      if (!mcpServers || !(SERVER_NAME in mcpServers)) return;
      delete mcpServers[SERVER_NAME];
      save(config);
      log(`Removed agentlink from ${configPath} for Cline`);
    },

    isConfigured() {
      const config = read();
      if (!config) return false;
      const mcpServers = config.mcpServers as
        | Record<string, unknown>
        | undefined;
      return !!mcpServers && SERVER_NAME in mcpServers;
    },
  };
}

// --- Codex: ~/.codex/config.toml ---
// Minimal TOML read/write for the [mcp_servers.agentlink] section.
// We preserve the rest of the file and only touch our section.

const CODEX_SECTION_HEADER = `[mcp_servers.${SERVER_NAME}]`;

function codexConfigPath(): string {
  return path.join(os.homedir(), ".codex", "config.toml");
}

/**
 * Build the TOML lines for our server section.
 * Codex uses `url` directly (no type field) and `http_headers` for static headers.
 */
function buildCodexSection(port: number, authToken?: string): string {
  const lines = [CODEX_SECTION_HEADER, `url = "http://localhost:${port}/mcp"`];
  if (authToken) {
    lines.push(`http_headers = { "Authorization" = "Bearer ${authToken}" }`);
  }
  return lines.join("\n");
}

/**
 * Remove the [mcp_servers.agentlink] section from TOML content.
 * Removes from the section header until the next [section] or EOF.
 */
function removeCodexSection(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let skipping = false;

  for (const line of lines) {
    if (line.trim() === CODEX_SECTION_HEADER) {
      skipping = true;
      continue;
    }
    // Stop skipping at next section header
    if (skipping && /^\[/.test(line.trim())) {
      skipping = false;
    }
    if (!skipping) {
      result.push(line);
    }
  }

  // Clean up trailing blank lines from removal
  while (result.length > 0 && result[result.length - 1].trim() === "") {
    result.pop();
  }
  if (result.length > 0) {
    result.push(""); // ensure trailing newline
  }

  return result.join("\n");
}

export function createCodexTomlWriter(log: LogFn): ConfigWriter {
  const configPath = codexConfigPath();

  function readContent(): string {
    try {
      if (!fs.existsSync(configPath)) return "";
      return fs.readFileSync(configPath, "utf-8");
    } catch {
      return "";
    }
  }

  function writeContent(content: string): boolean {
    const tmpPath = configPath + ".tmp." + process.pid;
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(tmpPath, content, "utf-8");
      fs.renameSync(tmpPath, configPath);
      return true;
    } catch (err) {
      log(`Warning: Could not write ${configPath}: ${err}`);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      return false;
    }
  }

  return {
    write(port, authToken) {
      let content = readContent();
      // Remove existing section if present
      content = removeCodexSection(content);
      // Append our section
      const section = buildCodexSection(port, authToken);
      content =
        content.trimEnd() + (content.trim() ? "\n\n" : "") + section + "\n";

      if (writeContent(content)) {
        log(`Updated ${configPath} with agentlink MCP server (port ${port})`);
        return true;
      }
      return false;
    },

    cleanup() {
      const content = readContent();
      if (!content.includes(CODEX_SECTION_HEADER)) return;
      const cleaned = removeCodexSection(content);
      writeContent(cleaned);
      log(`Removed agentlink from ${configPath}`);
    },

    isConfigured() {
      return readContent().includes(CODEX_SECTION_HEADER);
    },
  };
}

// --- Factory ---

export function createConfigWriter(
  agent: AgentDefinition,
  log: LogFn,
): ConfigWriter | null {
  switch (agent.configMethod) {
    case "claude-json":
      return createClaudeJsonWriter(log);

    case "vscode-mcp-json":
      return createWorkspaceJsonWriter(
        {
          relativePath: ".vscode/mcp.json",
          topLevelKey: "servers",
          httpType: agent.httpType ?? "http",
          agentName: agent.name,
        },
        log,
      );

    case "roo-mcp-json":
      return createWorkspaceJsonWriter(
        {
          relativePath: ".roo/mcp.json",
          topLevelKey: "mcpServers",
          httpType: agent.httpType ?? "streamable-http",
          agentName: agent.name,
        },
        log,
      );

    case "kilocode-mcp-json":
      return createWorkspaceJsonWriter(
        {
          relativePath: ".kilocode/mcp.json",
          topLevelKey: "mcpServers",
          httpType: agent.httpType ?? "streamable-http",
          agentName: agent.name,
        },
        log,
      );

    case "cline-settings-json":
      return createClineSettingsWriter(log);

    case "codex-toml":
      return createCodexTomlWriter(log);

    case "manual":
      // No auto-config for this agent
      return null;
  }
}
