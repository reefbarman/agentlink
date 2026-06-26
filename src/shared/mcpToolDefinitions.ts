import type { CoreModelToolDefinition } from "../core/modelRuntime.js";

export const CALL_MCP_TOOL_DEFINITION: CoreModelToolDefinition = {
  name: "call_mcp_tool",
  description:
    "Call a tool from a connected MCP server after discovering it with find_mcp_tools. Uses the same approval policy as directly exposed MCP tools.",
  input_schema: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "MCP server name, e.g. linear or notion.",
      },
      tool: {
        type: "string",
        description:
          "Bare MCP tool name without the server prefix, e.g. list_issues. Do not include server__.",
      },
      input: {
        type: "object",
        description: "Arguments object to pass to the MCP tool.",
      },
    },
    required: ["server", "tool", "input"],
  },
};

export const MCP_META_TOOL_DEFINITIONS: CoreModelToolDefinition[] = [
  {
    name: "find_mcp_tools",
    description:
      "Discover tools available from connected MCP servers. Use this before calling tools whose full schemas were deferred from the system prompt.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Optional case-insensitive search over server name, tool name, and description.",
        },
        server: {
          type: "string",
          description: "Optional MCP server name to restrict results to.",
        },
        includeSchemas: {
          type: "boolean",
          description:
            "Include full input schemas for matching tools. Default false. When true, schemas are limited by schemaLimit to keep discovery compact.",
        },
        schemaLimit: {
          type: "number",
          description:
            "Maximum number of returned tools that include full schemas when includeSchemas=true (default 1, max 20).",
        },
        limit: {
          type: "number",
          description: "Maximum tools to return (default 50, max 200).",
        },
      },
    },
  },
  {
    name: "list_mcp_resources",
    description: "List all resources available from connected MCP servers.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "read_mcp_resource",
    description: "Read a resource from an MCP server by URI.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server name" },
        uri: { type: "string", description: "Resource URI" },
      },
      required: ["server", "uri"],
    },
  },
  {
    name: "list_mcp_prompts",
    description:
      "List all prompt templates available from connected MCP servers.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_mcp_prompt",
    description:
      "Get a prompt template from an MCP server, optionally filling in arguments.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server name" },
        name: { type: "string", description: "Prompt name" },
        arguments: { type: "object", description: "Optional prompt arguments" },
      },
      required: ["server", "name"],
    },
  },
];

export const MCP_TOOL_BRIDGE_DEFINITIONS: CoreModelToolDefinition[] = [
  ...MCP_META_TOOL_DEFINITIONS,
  CALL_MCP_TOOL_DEFINITION,
];

export const MCP_TOOL_BRIDGE_TOOL_NAMES = MCP_TOOL_BRIDGE_DEFINITIONS.map(
  (tool) => tool.name,
);
