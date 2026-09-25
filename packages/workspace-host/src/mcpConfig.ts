import { promises as fs, constants as fsConstants } from "node:fs";

import path from "node:path";
import { readMcpConfig } from "@agentlink/node-host";

const MAX_CONFIG_BYTES = 1_000_000;
const MAX_TIMEOUT_MS = 60_000;
const SERVER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const CREDENTIAL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export interface WorkspaceMcpCredentialReference {
  readonly credential: string;
}

export interface WorkspaceMcpStdioDeclaration {
  readonly id: string;
  readonly source: "global" | "project";
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, WorkspaceMcpCredentialReference>>;
  readonly timeoutMs?: number;
}

export interface WorkspaceMcpRemoteDeclaration {
  readonly id: string;
  readonly source: "global" | "project";
  readonly transport: "streamable-http";
  readonly url: string;
  readonly headers: Readonly<Record<string, WorkspaceMcpCredentialReference>>;
  readonly oauth: boolean;
  readonly timeoutMs?: number;
}

export type WorkspaceMcpServerDeclaration =
  | WorkspaceMcpStdioDeclaration
  | WorkspaceMcpRemoteDeclaration;

/**
 * A validated, credential-free snapshot. Project declarations that are not
 * named in the global trust list are deliberately absent.
 */
export interface WorkspaceMcpConfiguration {
  readonly schemaVersion: 1;
  readonly projectRoot: string;
  readonly globalConfigPath: string;
  readonly projectConfigPath?: string;
  readonly servers: readonly WorkspaceMcpServerDeclaration[];
}

export interface WorkspaceMcpProjectDeclarationInspection {
  readonly projectRoot: string;
  readonly projectConfigPath?: string;
  readonly servers: readonly WorkspaceMcpServerDeclaration[];
}

export interface LoadWorkspaceMcpConfigurationOptions {
  /** Explicit CLI-owned host configuration. This file is required. */
  readonly globalConfigPath: string;
  /** Canonical workspace root used to contain all project-owned paths. */
  readonly projectRoot: string;
  /** Optional explicit declaration. A missing file is treated as no declaration. */
  readonly projectConfigPath?: string;
  /** Shared definitions shadow legacy entries, even when disabled. Re-read on each snapshot. */
  readonly shadowedLegacyServerIds?:
    | ReadonlySet<string>
    | (() => Promise<ReadonlySet<string>>);
}

interface ParsedHostConfiguration {
  readonly trustedProjectServerIds: ReadonlySet<string>;
  readonly servers: readonly ParsedServerDeclaration[];
}

interface ParsedProjectConfiguration {
  readonly servers: readonly ParsedServerDeclaration[];
}

interface ParsedStdioDeclaration {
  readonly id: string;
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, WorkspaceMcpCredentialReference>>;
  readonly timeoutMs?: number;
}

interface ParsedRemoteDeclaration {
  readonly id: string;
  readonly transport: "streamable-http";
  readonly url: string;
  readonly headers: Readonly<Record<string, WorkspaceMcpCredentialReference>>;
  readonly oauth: boolean;
  readonly timeoutMs?: number;
}

type ParsedServerDeclaration = ParsedStdioDeclaration | ParsedRemoteDeclaration;

export async function inspectWorkspaceMcpProjectDeclarations(
  projectRootValue: string,
  projectConfigPathValue: string,
): Promise<WorkspaceMcpProjectDeclarationInspection> {
  requireAbsolutePath(projectRootValue, "project root");
  requireAbsolutePath(projectConfigPathValue, "project MCP config path");
  const projectRoot = await canonicalDirectory(
    projectRootValue,
    "project root",
  );
  const projectConfigPath = await canonicalOptionalContainedFile(
    projectConfigPathValue,
    projectRoot,
    "project MCP config",
  );
  if (projectConfigPath === undefined) {
    return { projectRoot, servers: [] };
  }
  if (await isSharedMcpConfig(projectConfigPath)) {
    return { projectRoot, projectConfigPath, servers: [] };
  }
  const parsed = parseProjectConfiguration(
    await readJsonFile(projectConfigPath),
  );
  return {
    projectRoot,
    projectConfigPath,
    servers: await Promise.all(
      parsed.servers.map((server) =>
        normalizeProjectServer(server, projectRoot),
      ),
    ),
  };
}

export async function loadWorkspaceMcpConfiguration(
  options: LoadWorkspaceMcpConfigurationOptions,
): Promise<WorkspaceMcpConfiguration> {
  requireAbsolutePath(options.globalConfigPath, "global MCP config path");
  requireAbsolutePath(options.projectRoot, "project root");
  if (options.projectConfigPath !== undefined) {
    requireAbsolutePath(options.projectConfigPath, "project MCP config path");
  }

  const projectRoot = await canonicalDirectory(
    options.projectRoot,
    "project root",
  );
  const globalConfigPath = await canonicalFile(
    options.globalConfigPath,
    "global MCP config",
  );
  const host = parseHostConfiguration(await readJsonFile(globalConfigPath));
  const shadowedLegacyServerIds =
    typeof options.shadowedLegacyServerIds === "function"
      ? await options.shadowedLegacyServerIds()
      : options.shadowedLegacyServerIds;
  const globalServers = host.servers
    .filter((server) => !shadowedLegacyServerIds?.has(server.id))
    .map((server) => normalizeGlobalServer(server));

  let projectConfigPath: string | undefined;
  let project: ParsedProjectConfiguration = { servers: [] };
  if (options.projectConfigPath !== undefined) {
    projectConfigPath = await canonicalOptionalContainedFile(
      options.projectConfigPath,
      projectRoot,
      "project MCP config",
    );
    if (
      projectConfigPath !== undefined &&
      !(await isSharedMcpConfig(projectConfigPath))
    ) {
      project = parseProjectConfiguration(
        await readJsonFile(projectConfigPath),
      );
    }
  }

  const projectServers: WorkspaceMcpServerDeclaration[] = [];
  for (const server of project.servers) {
    if (
      !host.trustedProjectServerIds.has(server.id) ||
      shadowedLegacyServerIds?.has(server.id)
    )
      continue;
    projectServers.push(await normalizeProjectServer(server, projectRoot));
  }

  const ids = new Set<string>();
  for (const server of [...globalServers, ...projectServers]) {
    if (ids.has(server.id)) {
      throw new Error(
        `Duplicate MCP server id across trusted sources: ${server.id}`,
      );
    }
    ids.add(server.id);
  }

  return {
    schemaVersion: 1,
    projectRoot,
    globalConfigPath,
    ...(projectConfigPath === undefined ? {} : { projectConfigPath }),
    servers: [...globalServers, ...projectServers],
  };
}

function parseHostConfiguration(value: unknown): ParsedHostConfiguration {
  const record = strictRecord(
    value,
    ["schemaVersion", "trustedProjectServerIds", "servers"],
    "global MCP config",
  );
  if (record.schemaVersion !== 1) {
    throw new Error("Global MCP config schemaVersion must be 1");
  }
  const trustedIds = stringArray(
    record.trustedProjectServerIds,
    "trustedProjectServerIds",
  );
  ensureUniqueSafeIds(trustedIds, "trusted project server id");
  return {
    trustedProjectServerIds: new Set(trustedIds),
    servers: parseServers(record.servers, "global MCP config"),
  };
}

async function isSharedMcpConfig(filePath: string): Promise<boolean> {
  const read = await readMcpConfig(filePath);
  if (read.status === "invalid" || read.status === "unreadable") {
    throw new Error(`Project MCP config is invalid: ${filePath}`);
  }
  return read.status === "available" && read.config.mcpServers !== undefined;
}

function parseProjectConfiguration(value: unknown): ParsedProjectConfiguration {
  const record = strictRecord(
    value,
    ["schemaVersion", "servers"],
    "project MCP config",
  );
  if (record.schemaVersion !== 1) {
    throw new Error("Project MCP config schemaVersion must be 1");
  }
  return { servers: parseServers(record.servers, "project MCP config") };
}

function parseServers(
  value: unknown,
  label: string,
): ParsedServerDeclaration[] {
  if (!Array.isArray(value))
    throw new Error(`${label} servers must be an array`);
  const servers = value.map((server, index) =>
    parseServer(server, `${label} server ${index + 1}`),
  );
  ensureUniqueSafeIds(
    servers.map((server) => server.id),
    `${label} server id`,
  );
  return servers;
}

function parseServer(value: unknown, label: string): ParsedServerDeclaration {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (value.transport === "stdio") return parseStdioServer(value, label);
  if (value.transport === "streamable-http") {
    return parseRemoteServer(value, label);
  }
  throw new Error(`${label} transport must be stdio or streamable-http`);
}

function parseStdioServer(
  value: Record<string, unknown>,
  label: string,
): ParsedStdioDeclaration {
  const record = strictRecord(
    value,
    ["id", "transport", "command", "args", "cwd", "env", "timeoutMs"],
    label,
  );
  const id = safeServerId(record.id, `${label} id`);
  const command = requiredString(record.command, `${label} command`);
  const cwd = requiredString(record.cwd, `${label} cwd`);
  if (!path.isAbsolute(command))
    throw new Error(`${label} command must be absolute`);
  if (!path.isAbsolute(cwd)) throw new Error(`${label} cwd must be absolute`);
  const args =
    record.args === undefined ? [] : stringArray(record.args, `${label} args`);
  if (args.some((argument) => argument.includes("\0"))) {
    throw new Error(`${label} args must not contain NUL bytes`);
  }
  return {
    id,
    transport: "stdio",
    command,
    args,
    cwd,
    env: credentialReferenceMap(
      record.env,
      ENVIRONMENT_NAME_PATTERN,
      "environment variable",
      `${label} env`,
    ),
    ...optionalTimeout(record.timeoutMs, label),
  };
}

function parseRemoteServer(
  value: Record<string, unknown>,
  label: string,
): ParsedRemoteDeclaration {
  const record = strictRecord(
    value,
    ["id", "transport", "url", "headers", "oauth", "timeoutMs"],
    label,
  );
  const id = safeServerId(record.id, `${label} id`);
  const url = requiredString(record.url, `${label} url`);
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    throw new Error(`${label} url must be a valid HTTPS URL`);
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error(`${label} url must be credential-free HTTPS`);
  }
  if (record.oauth !== undefined && typeof record.oauth !== "boolean") {
    throw new Error(`${label} oauth must be a boolean`);
  }
  return {
    id,
    transport: "streamable-http",
    url: endpoint.toString(),
    headers: credentialReferenceMap(
      record.headers,
      HEADER_NAME_PATTERN,
      "HTTP header",
      `${label} headers`,
    ),
    oauth: record.oauth === true,
    ...optionalTimeout(record.timeoutMs, label),
  };
}

function normalizeGlobalServer(
  server: ParsedServerDeclaration,
): WorkspaceMcpServerDeclaration {
  return server.transport === "stdio"
    ? {
        ...server,
        source: "global",
        command: path.normalize(server.command),
        cwd: path.normalize(server.cwd),
      }
    : { ...server, source: "global" };
}

async function normalizeProjectServer(
  server: ParsedServerDeclaration,
  projectRoot: string,
): Promise<WorkspaceMcpServerDeclaration> {
  if (server.transport === "streamable-http") {
    return { ...server, source: "project" };
  }
  const command = await canonicalContainedPath(
    server.command,
    projectRoot,
    `Project MCP server ${server.id} command`,
    "file",
  );
  await fs.access(command, fsConstants.X_OK).catch(() => {
    throw new Error(
      `Project MCP server ${server.id} command is not executable`,
    );
  });
  const cwd = await canonicalContainedPath(
    server.cwd,
    projectRoot,
    `Project MCP server ${server.id} cwd`,
    "directory",
  );
  return { ...server, source: "project", command, cwd };
}

function credentialReferenceMap(
  value: unknown,
  namePattern: RegExp,
  nameLabel: string,
  label: string,
): Readonly<Record<string, WorkspaceMcpCredentialReference>> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const result: Record<string, WorkspaceMcpCredentialReference> = {};
  for (const [name, reference] of Object.entries(value)) {
    if (!namePattern.test(name))
      throw new Error(`${label} has an invalid ${nameLabel} name`);
    const record = strictRecord(reference, ["credential"], `${label}.${name}`);
    const credential = requiredString(
      record.credential,
      `${label}.${name}.credential`,
    );
    if (!CREDENTIAL_ID_PATTERN.test(credential)) {
      throw new Error(
        `${label}.${name}.credential is not a safe credential id`,
      );
    }
    result[name] = { credential };
  }
  return result;
}

function optionalTimeout(
  value: unknown,
  label: string,
): { readonly timeoutMs?: number } {
  if (value === undefined) return {};
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `${label} timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`,
    );
  }
  return { timeoutMs: value as number };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error(`MCP config is not a file: ${filePath}`);
  if (stats.size > MAX_CONFIG_BYTES)
    throw new Error(`MCP config is too large: ${filePath}`);
  const text = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`MCP config is not valid JSON: ${filePath}`);
  }
}

async function canonicalFile(filePath: string, label: string): Promise<string> {
  const canonical = await fs.realpath(filePath).catch(() => {
    throw new Error(`${label} does not exist: ${filePath}`);
  });
  const stats = await fs.stat(canonical);
  if (!stats.isFile()) throw new Error(`${label} must be a file`);
  return canonical;
}

async function canonicalDirectory(
  directory: string,
  label: string,
): Promise<string> {
  const canonical = await fs.realpath(directory).catch(() => {
    throw new Error(`${label} does not exist: ${directory}`);
  });
  const stats = await fs.stat(canonical);
  if (!stats.isDirectory()) throw new Error(`${label} must be a directory`);
  return canonical;
}

async function canonicalOptionalContainedFile(
  filePath: string,
  root: string,
  label: string,
): Promise<string | undefined> {
  try {
    return await canonicalContainedPath(filePath, root, label, "file");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    const ancestor = await nearestExistingAncestor(path.dirname(filePath));
    const canonicalAncestor = await fs.realpath(ancestor);
    ensureContained(root, canonicalAncestor, label);
    return undefined;
  }
}

async function canonicalContainedPath(
  candidate: string,
  root: string,
  label: string,
  kind: "file" | "directory",
): Promise<string> {
  const canonical = await fs.realpath(candidate);
  ensureContained(root, canonical, label);
  const stats = await fs.stat(canonical);
  if (kind === "file" ? !stats.isFile() : !stats.isDirectory()) {
    throw new Error(`${label} must be a ${kind}`);
  }
  return canonical;
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  for (;;) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function ensureContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new Error(`${label} escapes the canonical project root`);
}

function strictRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new Error(`${label} has unknown property: ${key}`);
  }
  return value;
}

function safeServerId(value: unknown, label: string): string {
  const id = requiredString(value, label);
  if (!SERVER_ID_PATTERN.test(id)) throw new Error(`${label} is not safe`);
  return id;
}

function ensureUniqueSafeIds(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    safeServerId(id, label);
    if (seen.has(id)) throw new Error(`Duplicate ${label}: ${id}`);
    seen.add(id);
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function requireAbsolutePath(value: string, label: string): void {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === code
  );
}
