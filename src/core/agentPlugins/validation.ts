import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import path from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";

import type {
  AgentPluginDiagnostic,
  AgentPluginHttpServer,
  AgentPluginManifest,
  AgentPluginMcpServer,
  AgentPluginMcpSnapshot,
  AgentPluginPackageLoadRequest,
  AgentPluginPackageSnapshot,
  AgentPluginSkillMetadata,
  AgentPluginSkillSnapshot,
  PluginPackageFileSystem,
} from "./contracts.js";
import { AGENT_PLUGIN_PACKAGE_SNAPSHOT_SCHEMA_VERSION } from "./contracts.js";
import { validateAgentPluginMcpHttpUrl } from "./httpPolicy.js";
import { isPathWithin, resolvePackagePath } from "./pathPolicy.js";
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
  AGENT_PLUGIN_MCP_SCHEMA_ID,
  AGENT_PLUGINS_SPECIFICATION_VERSION,
  agentPluginManifestSchema,
  agentPluginMcpSchema,
  getAgentPluginSchemaByManifestId,
  getAgentPluginSchemaByMcpId,
} from "./schemaRegistry.js";
import {
  parseStrictJson,
  type StrictJsonDuplicateMember,
} from "./strictJson.js";

const MANIFEST_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);
const SKILL_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);
const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const BARE_COMMAND_PATTERN = /^[^/\\\s]+$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

interface ValidatorSet {
  readonly manifest: ValidateFunction;
  readonly server: ValidateFunction;
}

let validators: ValidatorSet | undefined;

function getValidators(): ValidatorSet {
  if (validators) return validators;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });
  ajv.addSchema(agentPluginManifestSchema);
  ajv.addSchema(agentPluginMcpSchema);
  const manifest = ajv.getSchema(AGENT_PLUGIN_MANIFEST_SCHEMA_ID);
  const server = ajv.getSchema(`${AGENT_PLUGIN_MCP_SCHEMA_ID}#/$defs/server`);
  if (!manifest || !server) {
    throw new Error("Agent Plugins 1.0.0 schemas did not compile");
  }
  validators = { manifest, server };
  return validators;
}

export async function loadAgentPluginPackage(
  request: Readonly<AgentPluginPackageLoadRequest>,
): Promise<AgentPluginPackageSnapshot> {
  const diagnostics: AgentPluginDiagnostic[] = [];
  const rootPath = path.resolve(request.rootPath);
  const realRoot = await resolvePluginRoot(
    request.fileSystem,
    rootPath,
    diagnostics,
  );
  if (!realRoot) return invalidSnapshot(rootPath, diagnostics);

  const manifestResult = await loadManifest(
    request.fileSystem,
    realRoot,
    diagnostics,
  );
  if (!manifestResult) return invalidSnapshot(realRoot, diagnostics);

  const skills = await loadSkills(request.fileSystem, realRoot, diagnostics);
  const mcp = await loadMcp(
    request.fileSystem,
    realRoot,
    manifestResult.schema,
    diagnostics,
  );

  return {
    schemaVersion: AGENT_PLUGIN_PACKAGE_SNAPSHOT_SCHEMA_VERSION,
    specificationVersion: AGENT_PLUGINS_SPECIFICATION_VERSION,
    rootPath: realRoot,
    manifest: manifestResult,
    skills,
    ...(mcp ? { mcp } : {}),
    diagnostics,
    valid: true,
  };
}

async function resolvePluginRoot(
  fileSystem: PluginPackageFileSystem,
  rootPath: string,
  diagnostics: AgentPluginDiagnostic[],
): Promise<string | undefined> {
  try {
    const realRoot = await fileSystem.realpath(rootPath);
    const stat = await fileSystem.stat(realRoot);
    if (stat.kind !== "directory") {
      diagnostics.push(
        diagnostic(
          "plugin_root_not_directory",
          "package",
          "Plugin root must resolve to a directory.",
          rootPath,
        ),
      );
      return undefined;
    }
    return realRoot;
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "plugin_root_unavailable",
        "package",
        `Plugin root is unavailable: ${errorMessage(error)}`,
        rootPath,
      ),
    );
    return undefined;
  }
}

async function loadManifest(
  fileSystem: PluginPackageFileSystem,
  realRoot: string,
  diagnostics: AgentPluginDiagnostic[],
): Promise<AgentPluginManifest | undefined> {
  const manifestPath = path.join(realRoot, "plugin.json");
  const manifestFile = await requireContainedFile(
    fileSystem,
    realRoot,
    manifestPath,
    "manifest",
    diagnostics,
    "manifest_missing",
    "Manifest plugin.json is required.",
  );
  if (!manifestFile) return undefined;

  const document = parseJsonDocument(
    await fileSystem.readFile(manifestFile),
    "manifest",
    manifestPath,
    diagnostics,
  );
  const parsed = document?.value;
  if (document && document.duplicateMembers.length > 0) {
    addDuplicateDiagnostics(
      diagnostics,
      document.duplicateMembers,
      "manifest",
      manifestPath,
    );
    return undefined;
  }
  if (!isRecord(parsed)) {
    if (parsed !== undefined) {
      diagnostics.push(
        diagnostic(
          "manifest_not_object",
          "manifest",
          "plugin.json must contain a JSON object.",
          manifestPath,
          "$",
        ),
      );
    }
    return undefined;
  }

  const schema = getAgentPluginSchemaByManifestId(parsed.$schema);
  if (!schema) {
    diagnostics.push(
      diagnostic(
        "manifest_schema_unsupported",
        "manifest",
        "plugin.json must target a locally supported canonical Agent Plugins schema.",
        manifestPath,
        "$.$schema",
      ),
    );
    return undefined;
  }

  const preprocessed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!MANIFEST_FIELDS.has(key)) {
      diagnostics.push({
        ...diagnostic(
          "manifest_unknown_field",
          "manifest",
          `Unknown manifest field '${key}' was ignored.`,
          manifestPath,
          jsonMemberPath("$", key),
          "warning",
        ),
      });
      continue;
    }
    if (key === "extensions") {
      if (!isRecord(value)) {
        diagnostics.push(
          diagnostic(
            "manifest_extensions_not_object",
            "manifest",
            "Non-object manifest extensions were ignored.",
            manifestPath,
            "$.extensions",
            "warning",
          ),
        );
      } else {
        for (const namespace of Object.keys(value)) {
          diagnostics.push(
            diagnostic(
              "manifest_extension_ignored",
              "manifest",
              `Unimplemented extension namespace '${namespace}' was ignored without validating its value.`,
              manifestPath,
              jsonMemberPath("$.extensions", namespace),
              "info",
            ),
          );
        }
      }
      continue;
    }
    preprocessed[key] = value;
  }

  const validate = getValidators().manifest;
  if (!validate(preprocessed)) {
    addSchemaDiagnostics(
      diagnostics,
      validate.errors,
      "manifest_schema_invalid",
      "manifest",
      manifestPath,
      "$",
    );
    return undefined;
  }

  return toManifest(preprocessed);
}

async function loadSkills(
  fileSystem: PluginPackageFileSystem,
  realRoot: string,
  diagnostics: AgentPluginDiagnostic[],
): Promise<AgentPluginSkillSnapshot[]> {
  const skillsPath = path.join(realRoot, "skills");
  const location = await inspectOptionalLocation(fileSystem, skillsPath);
  if (location === "missing") return [];
  if (location !== "directory") {
    diagnostics.push(
      diagnostic(
        location === "escaping" ? "skills_path_escape" : "skills_not_directory",
        "skills",
        location === "escaping"
          ? "Skills location resolves outside the plugin root."
          : "Skills location must resolve to a directory.",
        skillsPath,
      ),
    );
    return [];
  }
  const realSkillsPath = await fileSystem.realpath(skillsPath);
  if (!isPathWithin(realSkillsPath, realRoot)) {
    diagnostics.push(
      diagnostic(
        "skills_path_escape",
        "skills",
        "Skills location resolves outside the plugin root.",
        skillsPath,
      ),
    );
    return [];
  }

  const entries = await fileSystem.readdir(realSkillsPath);
  const skills: AgentPluginSkillSnapshot[] = [];
  for (const entry of [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const directoryPath = path.join(realSkillsPath, entry.name);
    let realDirectory: string;
    try {
      if ((await fileSystem.stat(directoryPath)).kind !== "directory") continue;
      realDirectory = await fileSystem.realpath(directoryPath);
    } catch {
      continue;
    }
    if (!isPathWithin(realDirectory, realRoot)) {
      diagnostics.push(
        skillDiagnostic(
          "skill_directory_escape",
          entry.name,
          "Skill directory resolves outside the plugin root.",
          directoryPath,
        ),
      );
      continue;
    }

    const skillFiles = await fileSystem.readdir(realDirectory);
    if (!skillFiles.some((item) => item.name === "SKILL.md")) continue;
    const skillPath = path.join(realDirectory, "SKILL.md");
    const realSkillPath = await requireContainedFile(
      fileSystem,
      realRoot,
      skillPath,
      "skill",
      diagnostics,
      "skill_file_invalid",
      "SKILL.md must resolve to a regular file inside the plugin root.",
      entry.name,
    );
    if (!realSkillPath) continue;

    const content = await fileSystem.readFile(realSkillPath);
    const parsed = parseStrictSkill(content, entry.name, realSkillPath);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.skill) skills.push(parsed.skill);
  }
  return skills;
}

function parseStrictSkill(
  source: string,
  directoryName: string,
  skillPath: string,
): {
  readonly skill?: AgentPluginSkillSnapshot;
  readonly diagnostics: readonly AgentPluginDiagnostic[];
} {
  const diagnostics: AgentPluginDiagnostic[] = [];
  const normalized = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith("---\n")) {
    return {
      diagnostics: [
        skillDiagnostic(
          "skill_frontmatter_missing",
          directoryName,
          "SKILL.md must begin with YAML frontmatter.",
          skillPath,
        ),
      ],
    };
  }
  const closingDelimiter = /\n---(?:\n|$)/gu.exec(normalized.slice(4));
  const end = closingDelimiter ? closingDelimiter.index + 4 : -1;
  if (end < 0) {
    return {
      diagnostics: [
        skillDiagnostic(
          "skill_frontmatter_unterminated",
          directoryName,
          "SKILL.md frontmatter closing delimiter must occupy its own line.",
          skillPath,
        ),
      ],
    };
  }

  const document = parseDocument(normalized.slice(4, end), {
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || !isMap(document.contents)) {
    return {
      diagnostics: [
        skillDiagnostic(
          "skill_frontmatter_invalid",
          directoryName,
          document.errors.length > 0
            ? document.errors.map((error) => error.message).join("; ")
            : "SKILL.md frontmatter must be a YAML mapping.",
          skillPath,
        ),
      ],
    };
  }
  const raw = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!isRecord(raw)) {
    return {
      diagnostics: [
        skillDiagnostic(
          "skill_frontmatter_invalid",
          directoryName,
          "SKILL.md frontmatter must be a YAML mapping.",
          skillPath,
        ),
      ],
    };
  }

  for (const key of Object.keys(raw)) {
    if (!SKILL_FIELDS.has(key)) {
      diagnostics.push(
        skillDiagnostic(
          "skill_unknown_field",
          directoryName,
          `Unknown strict-profile frontmatter field '${key}'.`,
          skillPath,
          jsonMemberPath("$", key),
        ),
      );
    }
  }
  const metadataNode = document.contents.items.find(
    (pair) => isScalar(pair.key) && pair.key.value === "metadata",
  )?.value;
  const metadataUsesOnlyStringScalars =
    metadataNode === undefined ||
    (isMap(metadataNode) &&
      metadataNode.items.every(
        (pair) =>
          isScalar(pair.key) &&
          typeof pair.key.value === "string" &&
          isScalar(pair.value) &&
          typeof pair.value.value === "string",
      ));
  const metadata = validateSkillMetadata(
    raw,
    metadataUsesOnlyStringScalars,
    directoryName,
    skillPath,
    diagnostics,
  );
  if (!metadata || diagnostics.some((item) => item.severity === "error")) {
    return { diagnostics };
  }

  return {
    skill: {
      name: directoryName,
      directoryPath: path.dirname(skillPath),
      skillPath,
      metadata,
      body: normalized.slice(end + 4).replace(/^\n/u, ""),
    },
    diagnostics,
  };
}

function validateSkillMetadata(
  raw: Record<string, unknown>,
  metadataUsesOnlyStringScalars: boolean,
  directoryName: string,
  skillPath: string,
  diagnostics: AgentPluginDiagnostic[],
): AgentPluginSkillMetadata | undefined {
  const name = raw.name;
  const description = raw.description;
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 64 ||
    !SKILL_NAME_PATTERN.test(name)
  ) {
    diagnostics.push(
      skillDiagnostic(
        "skill_name_invalid",
        directoryName,
        "Skill name must be 1-64 ASCII lowercase letters, digits, or single hyphens.",
        skillPath,
        "$.name",
      ),
    );
  } else if (name !== directoryName) {
    diagnostics.push(
      skillDiagnostic(
        "skill_name_mismatch",
        directoryName,
        `Skill name '${name}' must equal parent directory '${directoryName}'.`,
        skillPath,
        "$.name",
      ),
    );
  }
  if (
    typeof description !== "string" ||
    description.length < 1 ||
    description.length > 1024
  ) {
    diagnostics.push(
      skillDiagnostic(
        "skill_description_invalid",
        directoryName,
        "Skill description must be a non-empty string of at most 1024 characters.",
        skillPath,
        "$.description",
      ),
    );
  }

  const license = optionalString(
    raw,
    "license",
    undefined,
    skillPath,
    directoryName,
    diagnostics,
  );
  const compatibility = optionalString(
    raw,
    "compatibility",
    { min: 1, max: 500 },
    skillPath,
    directoryName,
    diagnostics,
  );
  const allowedTools = optionalString(
    raw,
    "allowed-tools",
    undefined,
    skillPath,
    directoryName,
    diagnostics,
  );
  let metadata: Record<string, string> | undefined;
  if (raw.metadata !== undefined) {
    if (!isRecord(raw.metadata) || !metadataUsesOnlyStringScalars) {
      diagnostics.push(
        skillDiagnostic(
          "skill_metadata_invalid",
          directoryName,
          "Skill metadata must map string keys to string values without scalar coercion.",
          skillPath,
          "$.metadata",
        ),
      );
    } else {
      metadata = raw.metadata as Record<string, string>;
    }
  }

  if (
    typeof name !== "string" ||
    typeof description !== "string" ||
    diagnostics.some((item) => item.severity === "error")
  ) {
    return undefined;
  }
  return {
    name,
    description,
    ...(license !== undefined ? { license } : {}),
    ...(compatibility !== undefined ? { compatibility } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
  };
}

async function loadMcp(
  fileSystem: PluginPackageFileSystem,
  realRoot: string,
  manifestSchema: string,
  diagnostics: AgentPluginDiagnostic[],
): Promise<AgentPluginMcpSnapshot | undefined> {
  const mcpPath = path.join(realRoot, "mcp.json");
  if (!(await exists(fileSystem, mcpPath))) return undefined;
  const mcpFile = await requireContainedFile(
    fileSystem,
    realRoot,
    mcpPath,
    "mcp",
    diagnostics,
    "mcp_file_invalid",
    "mcp.json must resolve to a regular file inside the plugin root.",
  );
  if (!mcpFile) return undefined;
  const document = parseJsonDocument(
    await fileSystem.readFile(mcpFile),
    "mcp",
    mcpPath,
    diagnostics,
  );
  const parsed = document?.value;
  if (!isRecord(parsed)) {
    if (parsed !== undefined) {
      diagnostics.push(
        diagnostic(
          "mcp_not_object",
          "mcp",
          "mcp.json must contain a JSON object.",
          mcpPath,
          "$",
        ),
      );
    }
    return undefined;
  }

  const duplicateMembers = document?.duplicateMembers ?? [];
  const envelopeDuplicates = duplicateMembers.filter(
    (duplicate) =>
      duplicate.parentPath !== "$.mcpServers" &&
      !Object.keys(parsed.mcpServers ?? {}).some((serverName) =>
        duplicateBelongsToServer(duplicate, serverName),
      ),
  );
  if (envelopeDuplicates.length > 0) {
    addDuplicateDiagnostics(diagnostics, envelopeDuplicates, "mcp", mcpPath);
  }

  const keys = Object.keys(parsed);
  const unknownKeys = keys.filter(
    (key) => key !== "$schema" && key !== "mcpServers",
  );
  for (const key of unknownKeys) {
    diagnostics.push(
      diagnostic(
        "mcp_unknown_field",
        "mcp",
        `Unknown top-level MCP field '${key}'.`,
        mcpPath,
        jsonMemberPath("$", key),
      ),
    );
  }
  const schema = getAgentPluginSchemaByMcpId(parsed.$schema);
  if (!schema) {
    diagnostics.push(
      diagnostic(
        "mcp_schema_unsupported",
        "mcp",
        "mcp.json must target a locally supported canonical Agent Plugins MCP schema.",
        mcpPath,
        "$.$schema",
      ),
    );
  }
  if (manifestSchema !== AGENT_PLUGIN_MANIFEST_SCHEMA_ID || !schema) {
    // The manifest schema is version-selected before this point. Keep the check
    // explicit so future supported versions cannot be mixed accidentally.
  } else if (schema.version !== AGENT_PLUGINS_SPECIFICATION_VERSION) {
    diagnostics.push(
      diagnostic(
        "mcp_schema_version_mismatch",
        "mcp",
        "mcp.json targets a different Agent Plugins version than plugin.json.",
        mcpPath,
        "$.$schema",
      ),
    );
  }
  if (!isRecord(parsed.mcpServers)) {
    diagnostics.push(
      diagnostic(
        "mcp_servers_invalid",
        "mcp",
        "mcpServers must be an object.",
        mcpPath,
        "$.mcpServers",
      ),
    );
  }
  if (
    unknownKeys.length > 0 ||
    envelopeDuplicates.length > 0 ||
    !schema ||
    !isRecord(parsed.mcpServers) ||
    diagnostics.some(
      (item) => item.boundary === "mcp" && item.severity === "error",
    )
  ) {
    return undefined;
  }

  const servers: Record<string, AgentPluginMcpServer> = {};
  const validate = getValidators().server;
  for (const [serverName, value] of Object.entries(parsed.mcpServers)) {
    const serverDuplicates = duplicateMembers.filter(
      (duplicate) =>
        (duplicate.parentPath === "$.mcpServers" &&
          duplicate.key === serverName) ||
        duplicateBelongsToServer(duplicate, serverName),
    );
    if (serverDuplicates.length > 0) {
      for (const duplicate of serverDuplicates) {
        diagnostics.push({
          ...diagnostic(
            "duplicate_member",
            "mcp-server",
            duplicate.message,
            mcpPath,
            duplicate.path,
          ),
          componentName: serverName,
        });
      }
      continue;
    }
    if (!validate(value)) {
      addSchemaDiagnostics(
        diagnostics,
        validate.errors,
        "mcp_server_schema_invalid",
        "mcp-server",
        mcpPath,
        jsonMemberPath("$.mcpServers", serverName),
        serverName,
      );
      continue;
    }
    const server = value as AgentPluginMcpServer;
    const semanticErrors = await validateMcpServerSemantics(
      fileSystem,
      server,
      realRoot,
      mcpPath,
      serverName,
    );
    diagnostics.push(...semanticErrors);
    if (semanticErrors.length === 0) servers[serverName] = server;
  }

  return { schema: parsed.$schema as string, servers };
}

async function validateMcpServerSemantics(
  fileSystem: PluginPackageFileSystem,
  server: AgentPluginMcpServer,
  realRoot: string,
  mcpPath: string,
  serverName: string,
): Promise<AgentPluginDiagnostic[]> {
  const diagnostics: AgentPluginDiagnostic[] = [];
  const basePath = jsonMemberPath("$.mcpServers", serverName);
  if (server.type === "stdio") {
    if (
      !BARE_COMMAND_PATTERN.test(server.command) &&
      !server.command.startsWith("./")
    ) {
      diagnostics.push(
        mcpServerDiagnostic(
          "mcp_command_invalid",
          serverName,
          "Command must be one bare executable token or begin with './'.",
          mcpPath,
          `${basePath}.command`,
        ),
      );
    }
    if (server.command.startsWith("./")) {
      const resolved = await resolvePackagePath(
        fileSystem,
        realRoot,
        server.command,
      );
      if (!resolved.ok) {
        diagnostics.push(
          mcpServerDiagnostic(
            "mcp_command_escape",
            serverName,
            resolved.message,
            mcpPath,
            `${basePath}.command`,
          ),
        );
      }
    }
    if (server.cwd !== undefined) {
      const cwdError = await validateCwd(fileSystem, realRoot, server.cwd);
      if (cwdError) {
        diagnostics.push(
          mcpServerDiagnostic(
            "mcp_cwd_invalid",
            serverName,
            cwdError,
            mcpPath,
            `${basePath}.cwd`,
          ),
        );
      }
    }
    return diagnostics;
  }

  const urlError = validateAgentPluginMcpHttpUrl(server.url);
  if (urlError) {
    diagnostics.push(
      mcpServerDiagnostic(
        "mcp_url_invalid",
        serverName,
        urlError,
        mcpPath,
        `${basePath}.url`,
      ),
    );
  }
  diagnostics.push(
    ...validateHeaders(server, mcpPath, serverName, `${basePath}.headers`),
  );
  return diagnostics;
}

function validateHeaders(
  server: AgentPluginHttpServer,
  mcpPath: string,
  serverName: string,
  jsonPath: string,
): AgentPluginDiagnostic[] {
  const diagnostics: AgentPluginDiagnostic[] = [];
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(server.headers ?? {})) {
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) {
      diagnostics.push(
        mcpServerDiagnostic(
          "mcp_header_duplicate",
          serverName,
          `Header '${name}' duplicates another header case-insensitively.`,
          mcpPath,
          jsonMemberPath(jsonPath, name),
        ),
      );
    }
    seen.add(normalized);
    if (!HEADER_NAME_PATTERN.test(name)) {
      diagnostics.push(
        mcpServerDiagnostic(
          "mcp_header_name_invalid",
          serverName,
          `Header name '${name}' is invalid.`,
          mcpPath,
          jsonMemberPath(jsonPath, name),
        ),
      );
    }
    if (hasInvalidHeaderValueCharacter(value)) {
      diagnostics.push(
        mcpServerDiagnostic(
          "mcp_header_value_invalid",
          serverName,
          `Header '${name}' contains a forbidden control character.`,
          mcpPath,
          jsonMemberPath(jsonPath, name),
        ),
      );
    }
  }
  return diagnostics;
}

function hasInvalidHeaderValueCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code <= 0x1f && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

async function validateCwd(
  fileSystem: PluginPackageFileSystem,
  realRoot: string,
  value: string,
): Promise<string | undefined> {
  if (value.startsWith("./")) {
    const result = await resolvePackagePath(fileSystem, realRoot, value);
    return result.ok ? undefined : result.message;
  }
  if (value === "${PLUGIN_ROOT}" || value.startsWith("${PLUGIN_ROOT}/")) {
    const suffix = value.slice("${PLUGIN_ROOT}".length).replace(/^\//u, "");
    const result = await resolvePackagePath(
      fileSystem,
      realRoot,
      `./${suffix}`,
    );
    return result.ok ? undefined : result.message;
  }
  if (value === "${PLUGIN_DATA}" || value.startsWith("${PLUGIN_DATA}/")) {
    const suffix = value.slice("${PLUGIN_DATA}".length).replace(/^\//u, "");
    let depth = 0;
    for (const segment of suffix.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (depth === 0) return "Working directory escapes PLUGIN_DATA.";
        depth -= 1;
      } else {
        depth += 1;
      }
    }
    return undefined;
  }
  return "cwd must begin with './', '${PLUGIN_ROOT}', or '${PLUGIN_DATA}'.";
}

async function requireContainedFile(
  fileSystem: PluginPackageFileSystem,
  realRoot: string,
  filePath: string,
  boundary: AgentPluginDiagnostic["boundary"],
  diagnostics: AgentPluginDiagnostic[],
  code: string,
  message: string,
  componentName?: string,
): Promise<string | undefined> {
  try {
    if ((await fileSystem.stat(filePath)).kind !== "file") {
      diagnostics.push({
        ...diagnostic(code, boundary, message, filePath),
        ...(componentName ? { componentName } : {}),
      });
      return undefined;
    }
    const realPath = await fileSystem.realpath(filePath);
    if (!isPathWithin(realPath, realRoot)) {
      diagnostics.push({
        ...diagnostic(code, boundary, message, filePath),
        ...(componentName ? { componentName } : {}),
      });
      return undefined;
    }
    return realPath;
  } catch {
    diagnostics.push({
      ...diagnostic(code, boundary, message, filePath),
      ...(componentName ? { componentName } : {}),
    });
    return undefined;
  }
}

async function inspectOptionalLocation(
  fileSystem: PluginPackageFileSystem,
  locationPath: string,
): Promise<"missing" | "file" | "directory" | "other" | "escaping"> {
  try {
    const stat = await fileSystem.stat(locationPath);
    return stat.kind === "file" || stat.kind === "directory"
      ? stat.kind
      : "other";
  } catch {
    return "missing";
  }
}

interface ParsedJsonDocument {
  readonly value: unknown;
  readonly duplicateMembers: readonly StrictJsonDuplicateMember[];
}

function parseJsonDocument(
  source: string,
  boundary: "manifest" | "mcp",
  filePath: string,
  diagnostics: AgentPluginDiagnostic[],
): ParsedJsonDocument | undefined {
  const parsed = parseStrictJson(source);
  if (parsed.ok) {
    return {
      value: parsed.value,
      duplicateMembers: parsed.duplicateMembers,
    };
  }
  diagnostics.push(
    diagnostic(
      parsed.error.code,
      boundary,
      parsed.error.message,
      filePath,
      parsed.error.path,
    ),
  );
  return undefined;
}

function addDuplicateDiagnostics(
  diagnostics: AgentPluginDiagnostic[],
  duplicates: readonly StrictJsonDuplicateMember[],
  boundary: "manifest" | "mcp",
  filePath: string,
): void {
  for (const duplicate of duplicates) {
    diagnostics.push(
      diagnostic(
        "duplicate_member",
        boundary,
        duplicate.message,
        filePath,
        duplicate.path,
      ),
    );
  }
}

function duplicateBelongsToServer(
  duplicate: StrictJsonDuplicateMember,
  serverName: string,
): boolean {
  const prefix = jsonMemberPath("$.mcpServers", serverName);
  return (
    duplicate.parentPath === prefix ||
    duplicate.parentPath.startsWith(`${prefix}.`) ||
    duplicate.parentPath.startsWith(`${prefix}[`)
  );
}

function toManifest(value: Record<string, unknown>): AgentPluginManifest {
  const author = isRecord(value.author)
    ? {
        ...(typeof value.author.name === "string"
          ? { name: value.author.name }
          : {}),
        ...(typeof value.author.email === "string"
          ? { email: value.author.email }
          : {}),
        ...(typeof value.author.url === "string"
          ? { url: value.author.url }
          : {}),
      }
    : undefined;
  return {
    schema: value.$schema as string,
    name: value.name as string,
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    ...(author ? { author } : {}),
    ...(typeof value.homepage === "string" ? { homepage: value.homepage } : {}),
    ...(typeof value.repository === "string"
      ? { repository: value.repository }
      : {}),
    ...(typeof value.license === "string" ? { license: value.license } : {}),
    ...(Array.isArray(value.keywords)
      ? { keywords: value.keywords as string[] }
      : {}),
  };
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  bounds: { readonly min: number; readonly max: number } | undefined,
  skillPath: string,
  directoryName: string,
  diagnostics: AgentPluginDiagnostic[],
): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    (bounds && (value.length < bounds.min || value.length > bounds.max))
  ) {
    diagnostics.push(
      skillDiagnostic(
        `skill_${key.replaceAll("-", "_")}_invalid`,
        directoryName,
        bounds
          ? `Skill ${key} must be a string of ${bounds.min}-${bounds.max} characters.`
          : `Skill ${key} must be a string.`,
        skillPath,
        jsonMemberPath("$", key),
      ),
    );
    return undefined;
  }
  return value;
}

function addSchemaDiagnostics(
  diagnostics: AgentPluginDiagnostic[],
  errors: readonly ErrorObject[] | null | undefined,
  code: string,
  boundary: AgentPluginDiagnostic["boundary"],
  filePath: string,
  basePath: string,
  componentName?: string,
): void {
  for (const error of errors ?? []) {
    diagnostics.push({
      ...diagnostic(
        code,
        boundary,
        `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
        filePath,
        `${basePath}${error.instancePath.replaceAll("/", ".")}`,
      ),
      ...(componentName ? { componentName } : {}),
    });
  }
}

function diagnostic(
  code: string,
  boundary: AgentPluginDiagnostic["boundary"],
  message: string,
  filePath?: string,
  jsonPath?: string,
  severity: AgentPluginDiagnostic["severity"] = "error",
): AgentPluginDiagnostic {
  return {
    code,
    severity,
    layer: "portable",
    boundary,
    message,
    ...(filePath ? { path: filePath } : {}),
    ...(jsonPath ? { jsonPath } : {}),
  };
}

function skillDiagnostic(
  code: string,
  skillName: string,
  message: string,
  filePath: string,
  jsonPath?: string,
): AgentPluginDiagnostic {
  return {
    ...diagnostic(code, "skill", message, filePath, jsonPath),
    componentName: skillName,
  };
}

function mcpServerDiagnostic(
  code: string,
  serverName: string,
  message: string,
  filePath: string,
  jsonPath?: string,
): AgentPluginDiagnostic {
  return {
    ...diagnostic(code, "mcp-server", message, filePath, jsonPath),
    componentName: serverName,
  };
}

function invalidSnapshot(
  rootPath: string,
  diagnostics: readonly AgentPluginDiagnostic[],
): AgentPluginPackageSnapshot {
  return {
    schemaVersion: AGENT_PLUGIN_PACKAGE_SNAPSHOT_SCHEMA_VERSION,
    specificationVersion: AGENT_PLUGINS_SPECIFICATION_VERSION,
    rootPath,
    skills: [],
    diagnostics,
    valid: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(
  fileSystem: PluginPackageFileSystem,
  filePath: string,
): Promise<boolean> {
  try {
    await fileSystem.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

function jsonMemberPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { resolvePackagePath };
