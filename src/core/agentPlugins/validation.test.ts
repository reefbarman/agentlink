import * as fs from "node:fs/promises";

import {
  AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
  AGENT_PLUGIN_MCP_SCHEMA_ID,
} from "./schemaRegistry.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestPluginPackageFileSystem } from "../../test/pluginPackageFileSystem.js";
import { loadAgentPluginPackage } from "./validation.js";
import os from "node:os";
import path from "node:path";

describe("Agent Plugins 1.0.0 package validation", () => {
  let tempRoot: string;
  let pluginRoot: string;
  const fileSystem = createTestPluginPackageFileSystem();

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-plugin-validation-"),
    );
    pluginRoot = path.join(tempRoot, "plugin");
    await fs.mkdir(pluginRoot);
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("loads a deterministic package snapshot and ignores manifest exceptions", async () => {
    await writeJson("plugin.json", {
      $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
      name: "example.plugin",
      version: "not-semver",
      homepage: "not a URL",
      extensions: { "com.example.client": 42 },
      unknown: true,
    });
    await writeSkill(
      "summarize",
      [
        "---",
        "name: summarize",
        "description: Summarize a document.",
        "compatibility: Requires text input.",
        "metadata:",
        "  author: example",
        '  version: "1"',
        "allowed-tools: Read Bash(cat:*)",
        "---",
        "Use the bundled checklist.",
      ].join("\n"),
    );
    await writeJson("mcp.json", {
      $schema: AGENT_PLUGIN_MCP_SCHEMA_ID,
      mcpServers: {
        local: {
          type: "stdio",
          command: "./bin/generated-server",
          args: ["${PLUGIN_ROOT}/config.json"],
          env: { DATA: "${PLUGIN_DATA}/state" },
          cwd: "${PLUGIN_ROOT}",
        },
      },
    });
    await fs.mkdir(path.join(pluginRoot, "bin"));

    const first = await load();
    const second = await load();

    expect(first).toEqual(second);
    expect(first.valid).toBe(true);
    expect(first.manifest).toEqual(
      expect.objectContaining({
        name: "example.plugin",
        version: "not-semver",
        homepage: "not a URL",
      }),
    );
    expect(first.skills.map((skill) => skill.name)).toEqual(["summarize"]);
    expect(Object.keys(first.mcp?.servers ?? {})).toEqual(["local"]);
    expect(first.diagnostics.map((item) => item.code)).toEqual([
      "manifest_extension_ignored",
      "manifest_unknown_field",
    ]);
  });

  it("treats manifest duplicates and schema errors as package-fatal", async () => {
    await write(
      "plugin.json",
      `{"$schema":${JSON.stringify(AGENT_PLUGIN_MANIFEST_SCHEMA_ID)},"name":"first","name":"second"}`,
    );
    await writeSkill(
      "still-hidden",
      "---\nname: still-hidden\ndescription: Must not load.\n---\n",
    );

    const snapshot = await load();

    expect(snapshot.valid).toBe(false);
    expect(snapshot.manifest).toBeUndefined();
    expect(snapshot.skills).toEqual([]);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({
        code: "duplicate_member",
        boundary: "manifest",
        jsonPath: "$.name",
      }),
    ]);
  });

  it("skips invalid skills without blocking valid skills or MCP", async () => {
    await writeMinimalManifest();
    await writeSkill(
      "valid-skill",
      [
        "---",
        "name: valid-skill",
        "description: Valid skill.",
        "metadata:",
        '  version: "1"',
        "---",
      ].join("\n"),
    );
    await writeSkill(
      "invalid-skill",
      [
        "---",
        "name: invalid-skill",
        "description: Invalid scalar metadata value.",
        "metadata:",
        "  version: 1",
        "---",
      ].join("\n"),
    );
    await writeSkill(
      "invalid-metadata-key",
      [
        "---",
        "name: invalid-metadata-key",
        "description: Invalid scalar metadata key.",
        "metadata:",
        "  1: version",
        "---",
      ].join("\n"),
    );
    await fs.mkdir(path.join(pluginRoot, "skills", "lowercase"), {
      recursive: true,
    });
    await write(
      path.join("skills", "lowercase", "skill.md"),
      "---\nname: lowercase\ndescription: Not discovered.\n---\n",
    );
    await writeJson("mcp.json", {
      $schema: AGENT_PLUGIN_MCP_SCHEMA_ID,
      mcpServers: {
        remote: { type: "streamable-http", url: "https://example.com/mcp" },
      },
    });

    const snapshot = await load();

    expect(snapshot.valid).toBe(true);
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["valid-skill"]);
    expect(snapshot.skills[0]?.body).toBe("");
    expect(Object.keys(snapshot.mcp?.servers ?? {})).toEqual(["remote"]);
    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "skill_metadata_invalid",
          componentName: "invalid-skill",
        }),
        expect.objectContaining({
          code: "skill_metadata_invalid",
          componentName: "invalid-metadata-key",
        }),
      ]),
    );
  });

  it("orders skills deterministically by code unit", async () => {
    await writeMinimalManifest();
    await writeSkill(
      "a0skill",
      "---\nname: a0skill\ndescription: Digit sort key.\n---\n",
    );
    await writeSkill(
      "a-skill",
      "---\nname: a-skill\ndescription: Hyphen sort key.\n---\n",
    );

    const snapshot = await load();

    expect(snapshot.skills.map((skill) => skill.name)).toEqual([
      "a-skill",
      "a0skill",
    ]);
  });

  it("recognizes only a standalone three-hyphen frontmatter terminator", async () => {
    await writeMinimalManifest();
    await writeSkill(
      "hyphen-key",
      [
        "---",
        "name: hyphen-key",
        "description: Longer hyphen-prefixed keys remain YAML content.",
        "----: value",
        "---",
        "Body.",
      ].join("\n"),
    );

    const snapshot = await load();

    expect(snapshot.skills).toEqual([]);
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "skill_unknown_field",
        componentName: "hyphen-key",
        jsonPath: '$["----"]',
      }),
    );
    expect(snapshot.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "skill_frontmatter_unterminated" }),
    );
  });

  it("isolates invalid and duplicate MCP server entries", async () => {
    await writeMinimalManifest();
    await write(
      "mcp.json",
      [
        "{",
        `  "$schema": ${JSON.stringify(AGENT_PLUGIN_MCP_SCHEMA_ID)},`,
        '  "mcpServers": {',
        '    "valid": { "type": "stdio", "command": "node" },',
        '    "unknown-field": { "type": "stdio", "command": "node", "extra": true },',
        '    "duplicate": { "type": "stdio", "command": "node", "command": "other" },',
        '    "bad-url": { "type": "streamable-http", "url": "http://example.com/mcp" },',
        '    "bad-headers": { "type": "sse", "url": "https://example.com/sse", "headers": { "X-Test": "one", "x-test": "two" } }',
        "  }",
        "}",
      ].join("\n"),
    );

    const snapshot = await load();

    expect(snapshot.valid).toBe(true);
    expect(Object.keys(snapshot.mcp?.servers ?? {})).toEqual(["valid"]);
    expect(
      snapshot.diagnostics
        .filter((item) => item.boundary === "mcp-server")
        .map((item) => [item.componentName, item.code]),
    ).toEqual(
      expect.arrayContaining([
        ["unknown-field", "mcp_server_schema_invalid"],
        ["duplicate", "duplicate_member"],
        ["bad-url", "mcp_url_invalid"],
        ["bad-headers", "mcp_header_duplicate"],
      ]),
    );
  });

  it("makes an MCP envelope duplicate fatal only to MCP", async () => {
    await writeMinimalManifest();
    await writeSkill(
      "survives",
      "---\nname: survives\ndescription: Still available.\n---\n",
    );
    await write(
      "mcp.json",
      `{"$schema":${JSON.stringify(AGENT_PLUGIN_MCP_SCHEMA_ID)},"mcpServers":{},"mcpServers":{"late":{"type":"stdio","command":"node"}}}`,
    );

    const snapshot = await load();

    expect(snapshot.valid).toBe(true);
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["survives"]);
    expect(snapshot.mcp).toBeUndefined();
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({ code: "duplicate_member", boundary: "mcp" }),
    );
  });

  it("rejects escaping skill and MCP symlinks but accepts contained missing leaves", async () => {
    await writeMinimalManifest();
    const outside = path.join(tempRoot, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(
      path.join(outside, "SKILL.md"),
      "---\nname: escaped\ndescription: Escaped.\n---\n",
    );
    await fs.mkdir(path.join(pluginRoot, "skills"));
    await fs.symlink(outside, path.join(pluginRoot, "skills", "escaped"));
    await fs.symlink(outside, path.join(pluginRoot, "outside-link"));
    await writeJson("mcp.json", {
      $schema: AGENT_PLUGIN_MCP_SCHEMA_ID,
      mcpServers: {
        escaped: { type: "stdio", command: "./outside-link/server" },
        missing: {
          type: "stdio",
          command: "./generated/server",
          cwd: "./generated",
        },
        dataEscape: {
          type: "stdio",
          command: "node",
          cwd: "${PLUGIN_DATA}/../../outside",
        },
      },
    });

    const snapshot = await load();

    expect(snapshot.skills).toEqual([]);
    expect(Object.keys(snapshot.mcp?.servers ?? {})).toEqual(["missing"]);
    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "skill_directory_escape",
          componentName: "escaped",
        }),
        expect.objectContaining({
          code: "mcp_command_escape",
          componentName: "escaped",
        }),
        expect.objectContaining({
          code: "mcp_cwd_invalid",
          componentName: "dataEscape",
        }),
      ]),
    );
  });

  async function load() {
    return loadAgentPluginPackage({ rootPath: pluginRoot, fileSystem });
  }

  async function writeMinimalManifest() {
    await writeJson("plugin.json", {
      $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
      name: "example-plugin",
    });
  }

  async function writeSkill(name: string, content: string) {
    await write(path.join("skills", name, "SKILL.md"), content);
  }

  async function writeJson(relativePath: string, value: unknown) {
    await write(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async function write(relativePath: string, content: string) {
    const destination = path.join(pluginRoot, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content, "utf8");
  }
});
