import { describe, expect, it } from "vitest";

import type { HostToolResult } from "@agentlink/core";
import { createNodeHostReadTools } from "./readTools.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };
const context = {
  principal,
  sessionId: "session-a",
  turnId: "turn-a",
  model: {
    model: { providerId: "fixture", modelId: "fixture-model" },
    source: "runtime" as const,
  },
  signal: undefined,
};

async function tool(
  resolver: ReturnType<typeof createNodeHostReadTools>,
  name: string,
) {
  const tools = await resolver({
    principal,
    sessionId: "session-a",
    turnId: "turn-a",
  });
  const resolved = tools.find(
    (candidate) => candidate.definition.name === name,
  );
  if (!resolved) throw new Error(`Missing test tool ${name}`);
  return resolved;
}

function content(result: HostToolResult) {
  if (typeof result.modelContent !== "string") {
    throw new Error("Expected a text-only node-host read result");
  }
  return JSON.parse(result.modelContent) as Record<string, unknown>;
}

describe("node host read tools", () => {
  it("reads only a granted directory, redacts structured secrets, and rejects symlink escapes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "node-host-read-"));
    const granted = path.join(root, "granted");
    const denied = path.join(root, "denied");
    await fs.mkdir(granted);
    await fs.mkdir(denied);
    const allowedFile = path.join(granted, "notes.txt");
    const settingsFile = path.join(granted, "settings.json");
    const deniedFile = path.join(denied, "secret.txt");
    const escape = path.join(granted, "escape.txt");
    await fs.writeFile(allowedFile, "alpha\nbeta target\ngamma", "utf8");
    await fs.writeFile(
      settingsFile,
      '{"theme":"dark","apiKey":"secret"}',
      "utf8",
    );
    await fs.writeFile(deniedFile, "do not disclose", "utf8");
    await fs.symlink(deniedFile, escape);

    const resolver = createNodeHostReadTools({
      resolveGrants: () => [{ rootPath: granted, kind: "directory" }],
    });
    const read = await tool(resolver, "read_file");

    await expect(
      read.execute({ path: allowedFile, offset: 2, limit: 1 }, context),
    ).resolves.toMatchObject({
      modelContent: expect.stringContaining("2 | beta target"),
    });
    const settings = await read.execute({ path: settingsFile }, context);
    expect(settings.modelContent).toContain("[REDACTED]");
    expect(settings.modelContent).not.toContain('"secret"');
    const search = await tool(resolver, "search_files");
    const searched = await search.execute(
      { path: granted, regex: "apiKey" },
      context,
    );
    expect(searched.modelContent).toContain("[REDACTED]");
    expect(searched.modelContent).not.toContain('"secret"');
    await expect(
      read.execute({ path: deniedFile }, context),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({ error: "path_not_granted" }),
    });
    await expect(
      read.execute({ path: escape }, context),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({ error: "path_not_granted" }),
    });

    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps file grants exact and bounds directory list/search operations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "node-host-search-"));
    const grantedFile = path.join(root, "granted.txt");
    const siblingFile = path.join(root, "sibling.txt");
    const nested = path.join(root, "nested");
    await fs.writeFile(grantedFile, "target one", "utf8");
    await fs.writeFile(siblingFile, "target sibling", "utf8");
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, "deep.txt"), "target deep", "utf8");

    const fileResolver = createNodeHostReadTools({
      resolveGrants: () => [{ rootPath: grantedFile, kind: "file" }],
    });
    const read = await tool(fileResolver, "read_file");
    await expect(
      read.execute({ path: grantedFile }, context),
    ).resolves.not.toHaveProperty("isError");
    await expect(
      read.execute({ path: siblingFile }, context),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({ error: "path_not_granted" }),
    });
    const list = await tool(fileResolver, "list_files");
    await expect(list.execute({ path: root }, context)).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({ error: "path_not_granted" }),
    });

    const directoryResolver = createNodeHostReadTools({
      resolveGrants: () => [{ rootPath: root, kind: "directory" }],
      maxListEntries: 2,
      maxSearchResults: 2,
    });
    const listDirectory = await tool(directoryResolver, "list_files");
    const listed = content(
      await listDirectory.execute(
        { path: root, recursive: true, depth: 3 },
        context,
      ),
    );
    expect(listed).toMatchObject({ count: 2, truncated: true });
    const search = await tool(directoryResolver, "search_files");
    const searched = content(
      await search.execute({ path: root, regex: "target" }, context),
    );
    expect(searched).toMatchObject({ count: 2, truncated: true });
    await expect(
      search.execute({ path: root, regex: "(" }, context),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({ error: "invalid_regex" }),
    });

    await fs.rm(root, { recursive: true, force: true });
  });
});
