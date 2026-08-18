import {
  AGENT_PLUGINS_SPECIFICATION_COMMIT,
  AGENT_PLUGINS_SPECIFICATION_VERSION,
  AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
  AGENT_PLUGIN_MCP_SCHEMA_ID,
  AGENT_SKILLS_SPECIFICATION_COMMIT,
  agentPluginManifestSchema,
  agentPluginMcpSchema,
  getAgentPluginSchemaByManifestId,
  getAgentPluginSchemaByMcpId,
} from "./schemaRegistry.js";
import { describe, expect, it } from "vitest";

import path from "node:path";
import { readFile } from "node:fs/promises";

describe("Agent Plugin schema registry", () => {
  it("dispatches only exact canonical 1.0.0 identifiers", () => {
    expect(
      getAgentPluginSchemaByManifestId(AGENT_PLUGIN_MANIFEST_SCHEMA_ID)
        ?.version,
    ).toBe(AGENT_PLUGINS_SPECIFICATION_VERSION);
    expect(
      getAgentPluginSchemaByMcpId(AGENT_PLUGIN_MCP_SCHEMA_ID)?.version,
    ).toBe(AGENT_PLUGINS_SPECIFICATION_VERSION);
    expect(
      getAgentPluginSchemaByManifestId(`${AGENT_PLUGIN_MANIFEST_SCHEMA_ID}#`),
    ).toBeUndefined();
    expect(
      getAgentPluginSchemaByMcpId("https://example.test/mcp.schema.json"),
    ).toBeUndefined();
  });

  it("keeps executable schemas identical to the vendored assets", async () => {
    const resourceRoot = path.resolve(
      process.cwd(),
      "resources/agent-plugins/1.0.0",
    );
    const [manifest, mcp] = await Promise.all([
      readFile(path.join(resourceRoot, "plugin.schema.json"), "utf8"),
      readFile(path.join(resourceRoot, "mcp.schema.json"), "utf8"),
    ]);

    expect(agentPluginManifestSchema).toEqual(JSON.parse(manifest));
    expect(agentPluginMcpSchema).toEqual(JSON.parse(mcp));
  });

  it("pins reviewed upstream revisions", () => {
    expect(AGENT_PLUGINS_SPECIFICATION_COMMIT).toMatch(/^[0-9a-f]{40}$/u);
    expect(AGENT_SKILLS_SPECIFICATION_COMMIT).toMatch(/^[0-9a-f]{40}$/u);
  });
});
