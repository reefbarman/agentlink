export const AGENT_PLUGINS_SPECIFICATION_VERSION = "1.0.0" as const;
export const AGENT_PLUGINS_SPECIFICATION_COMMIT =
  "bd383552095128f6effe895b9257cfd580a6d179" as const;
export const AGENT_SKILLS_SPECIFICATION_COMMIT =
  "217be548739f21d6008915c29aefe320ea1a90af" as const;

export const AGENT_PLUGIN_MANIFEST_SCHEMA_ID =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" as const;
export const AGENT_PLUGIN_MCP_SCHEMA_ID =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" as const;

export const agentPluginManifestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
  title: "Agent Plugins Manifest",
  description:
    "Machine-readable schema for plugin.json in Agent Plugins 1.0.0. The Agent Plugins specification defines additional semantic and operational requirements.",
  type: "object",
  properties: {
    $schema: {
      const: AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
      description:
        "Canonical identifier of the plugin manifest schema for the Agent Plugins version targeted by this document.",
    },
    name: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^(?!.*(?:--|\\.\\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$",
      description: "Human-readable plugin name.",
    },
    version: { type: "string" },
    description: { type: "string" },
    author: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        url: { type: "string" },
      },
      additionalProperties: false,
    },
    homepage: { type: "string" },
    repository: { type: "string" },
    license: { type: "string" },
    keywords: { type: "array", items: { type: "string" } },
    extensions: {
      type: "object",
      description:
        "Client-specific manifest data keyed by reverse-domain extension namespace. Agent Plugins assigns no semantics to namespace object contents.",
      additionalProperties: { type: "object" },
    },
  },
  required: ["$schema", "name"],
  additionalProperties: false,
} as const;

const headersSchema = {
  title: "HTTP headers",
  type: "object",
  additionalProperties: { type: "string" },
} as const;

const stdioServerSchema = {
  title: "stdio MCP server",
  type: "object",
  properties: {
    type: { const: "stdio" },
    command: {
      type: "string",
      minLength: 1,
      description:
        "Executable token. Resolution rules are defined by the Agent Plugins specification.",
    },
    args: { type: "array", items: { type: "string" } },
    env: {
      type: "object",
      propertyNames: {
        not: { enum: ["PLUGIN_ROOT", "PLUGIN_DATA"] },
      },
      additionalProperties: { type: "string" },
    },
    cwd: {
      type: "string",
      pattern:
        "^(?:\\./|\\$\\{PLUGIN_ROOT\\}(?:/|$)|\\$\\{PLUGIN_DATA\\}(?:/|$))",
      description:
        "Plugin-relative, PLUGIN_ROOT-rooted, or PLUGIN_DATA-rooted working directory. Filesystem containment is validated separately.",
    },
  },
  required: ["type", "command"],
  additionalProperties: false,
} as const;

const streamableHttpServerSchema = {
  title: "Streamable HTTP MCP server",
  type: "object",
  properties: {
    type: { const: "streamable-http" },
    url: {
      type: "string",
      minLength: 1,
      description:
        "MCP endpoint URL. URL semantics are defined by the Agent Plugins specification.",
    },
    headers: { $ref: "#/$defs/headers" },
  },
  required: ["type", "url"],
  additionalProperties: false,
} as const;

const sseServerSchema = {
  title: "Legacy HTTP+SSE MCP server",
  type: "object",
  properties: {
    type: { const: "sse" },
    url: {
      type: "string",
      minLength: 1,
      description:
        "MCP endpoint URL. URL semantics are defined by the Agent Plugins specification.",
    },
    headers: { $ref: "#/$defs/headers" },
  },
  required: ["type", "url"],
  additionalProperties: false,
} as const;

export const agentPluginMcpSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: AGENT_PLUGIN_MCP_SCHEMA_ID,
  title: "Agent Plugins MCP Configuration",
  description:
    "Machine-readable schema for mcp.json in Agent Plugins 1.0.0. The Agent Plugins specification defines additional semantic and operational requirements.",
  type: "object",
  properties: {
    $schema: {
      const: AGENT_PLUGIN_MCP_SCHEMA_ID,
      description:
        "Canonical identifier of the MCP configuration schema for the Agent Plugins version targeted by this document.",
    },
    mcpServers: {
      type: "object",
      additionalProperties: { $ref: "#/$defs/server" },
    },
  },
  required: ["$schema", "mcpServers"],
  additionalProperties: false,
  $defs: {
    server: {
      title: "MCP server",
      oneOf: [
        { $ref: "#/$defs/stdioServer" },
        { $ref: "#/$defs/streamableHttpServer" },
        { $ref: "#/$defs/sseServer" },
      ],
    },
    stdioServer: stdioServerSchema,
    streamableHttpServer: streamableHttpServerSchema,
    sseServer: sseServerSchema,
    headers: headersSchema,
  },
} as const;

export interface AgentPluginSchemaVersionDefinition {
  readonly version: typeof AGENT_PLUGINS_SPECIFICATION_VERSION;
  readonly manifestSchemaId: typeof AGENT_PLUGIN_MANIFEST_SCHEMA_ID;
  readonly mcpSchemaId: typeof AGENT_PLUGIN_MCP_SCHEMA_ID;
  readonly manifestSchema: typeof agentPluginManifestSchema;
  readonly mcpSchema: typeof agentPluginMcpSchema;
}

export const agentPluginSchemaV1: AgentPluginSchemaVersionDefinition = {
  version: AGENT_PLUGINS_SPECIFICATION_VERSION,
  manifestSchemaId: AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
  mcpSchemaId: AGENT_PLUGIN_MCP_SCHEMA_ID,
  manifestSchema: agentPluginManifestSchema,
  mcpSchema: agentPluginMcpSchema,
};

export function getAgentPluginSchemaByManifestId(
  schemaId: unknown,
): AgentPluginSchemaVersionDefinition | undefined {
  return schemaId === AGENT_PLUGIN_MANIFEST_SCHEMA_ID
    ? agentPluginSchemaV1
    : undefined;
}

export function getAgentPluginSchemaByMcpId(
  schemaId: unknown,
): AgentPluginSchemaVersionDefinition | undefined {
  return schemaId === AGENT_PLUGIN_MCP_SCHEMA_ID
    ? agentPluginSchemaV1
    : undefined;
}
