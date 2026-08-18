export const AGENT_PLUGIN_PACKAGE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type AgentPluginDiagnosticSeverity = "info" | "warning" | "error";
export type AgentPluginDiagnosticLayer = "portable" | "agentlink-policy";
export type AgentPluginDiagnosticBoundary =
  | "package"
  | "manifest"
  | "skills"
  | "skill"
  | "mcp"
  | "mcp-server";

export interface AgentPluginDiagnostic {
  readonly code: string;
  readonly severity: AgentPluginDiagnosticSeverity;
  readonly layer: AgentPluginDiagnosticLayer;
  readonly boundary: AgentPluginDiagnosticBoundary;
  readonly message: string;
  readonly path?: string;
  readonly jsonPath?: string;
  readonly componentName?: string;
}

export interface AgentPluginAuthor {
  readonly name?: string;
  readonly email?: string;
  readonly url?: string;
}

export interface AgentPluginManifest {
  readonly schema: string;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: AgentPluginAuthor;
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords?: readonly string[];
}

export interface AgentPluginSkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly allowedTools?: string;
}

export interface AgentPluginSkillSnapshot {
  readonly name: string;
  readonly directoryPath: string;
  readonly skillPath: string;
  readonly metadata: AgentPluginSkillMetadata;
  readonly body: string;
}

export interface AgentPluginStdioServer {
  readonly type: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface AgentPluginHttpServer {
  readonly type: "streamable-http" | "sse";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type AgentPluginMcpServer =
  | AgentPluginStdioServer
  | AgentPluginHttpServer;

export interface AgentPluginMcpSnapshot {
  readonly schema: string;
  readonly servers: Readonly<Record<string, AgentPluginMcpServer>>;
}

export interface AgentPluginPackageSnapshot {
  readonly schemaVersion: typeof AGENT_PLUGIN_PACKAGE_SNAPSHOT_SCHEMA_VERSION;
  readonly specificationVersion: string;
  readonly rootPath: string;
  readonly manifest?: AgentPluginManifest;
  readonly skills: readonly AgentPluginSkillSnapshot[];
  readonly mcp?: AgentPluginMcpSnapshot;
  readonly diagnostics: readonly AgentPluginDiagnostic[];
  readonly valid: boolean;
}

export interface PluginPackageDirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
}

export interface PluginPackageFileStat {
  readonly kind: "file" | "directory" | "symlink" | "other";
}

/** Portable filesystem boundary used by package validation and fixture adapters. */
export interface PluginPackageFileSystem {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<readonly PluginPackageDirectoryEntry[]>;
  lstat(path: string): Promise<PluginPackageFileStat>;
  stat(path: string): Promise<PluginPackageFileStat>;
  realpath(path: string): Promise<string>;
}

export interface AgentPluginPackageLoadRequest {
  readonly rootPath: string;
  readonly fileSystem: PluginPackageFileSystem;
}

export interface PortablePluginMcpRuntimeEntry {
  readonly serverName: string;
  readonly server: AgentPluginMcpServer;
  readonly pluginRoot: string;
  readonly pluginData: string;
}
