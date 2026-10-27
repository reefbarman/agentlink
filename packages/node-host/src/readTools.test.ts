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
    input: { text: "test", attachments: undefined },
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
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "node-host-read-"),
    );
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
      modelContent: JSON.stringify({ error: "path_alias" }),
    });

    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps file grants exact and bounds directory list/search operations", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "node-host-search-"),
    );
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
    expect(
      (
        search.definition.input_schema.properties as Record<
          string,
          { maximum?: number }
        >
      ).max_results?.maximum,
    ).toBe(2);
    const searched = content(
      await search.execute({ path: root, regex: "target" }, context),
    );
    expect(searched).toMatchObject({ total_matches: 2, truncated: true });
    await expect(
      search.execute({ path: root, regex: "(" }, context),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: expect.stringContaining('"error":"Invalid regex:'),
    });

    await fs.rm(root, { recursive: true, force: true });
  });

  it("follows VS Code's search_files contract without ripgrep", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "node-host-regex-"),
    );
    const write = async (relative: string, text: string) => {
      await fs.mkdir(path.dirname(path.join(root, relative)), {
        recursive: true,
      });
      await fs.writeFile(path.join(root, relative), text, "utf8");
    };
    await write("a.ts", "one\nneedle here\nthree\nfour\nneedle again\n");
    await write("src/b.ts", "Needle upper\n");
    await write("src/c.md", "needle in markdown\n");
    await write(".hidden/d.ts", "needle hidden\n");
    await write("node_modules/e.ts", "needle dependency\n");
    await write("multi.txt", "start\nfunction foo(\n  bar\n)\nend\n");
    const resolver = createNodeHostReadTools({
      resolveGrants: () => [{ rootPath: root, kind: "directory" }],
      formatSearchPath: (absolute) => path.relative(root, absolute),
    });
    const search = await tool(resolver, "search_files");
    const run = async (input: Record<string, unknown>) =>
      content(await search.execute({ path: root, ...input }, context));

    expect(await run({ regex: "needle", context: 0 })).toEqual({
      total_matches: 3,
      truncated: false,
      results:
        "## a.ts (2 matches)\n> 2 | needle here\n---\n> 5 | needle again\n---\n\n## src/c.md (1 match)\n> 1 | needle in markdown\n---",
    });
    expect(
      await run({ regex: "needle", file_pattern: "a.ts", context_after: 1 }),
    ).toMatchObject({
      results:
        "## a.ts (2 matches)\n  1 | one\n> 2 | needle here\n  3 | three\n  4 | four\n> 5 | needle again\n---",
    });
    expect(
      await run({
        regex: "needle",
        case_insensitive: true,
        output_mode: "files_with_matches",
      }),
    ).toEqual({
      total_files: 3,
      truncated: false,
      files: ["a.ts", "src/b.ts", "src/c.md"],
    });
    expect(
      await run({
        regex: "needle",
        output_mode: "count",
        file_pattern: "*.ts",
      }),
    ).toEqual({
      total_files: 1,
      total_matches: 2,
      truncated: false,
      counts: [{ file: "a.ts", count: 2 }],
    });
    expect(
      await run({ regex: "needle", max_results: 1, offset: 1, context: 0 }),
    ).toMatchObject({
      total_matches: 1,
      truncated: true,
      offset: 1,
      results: "## a.ts (1 match)\n> 5 | needle again\n---",
    });
    expect(await run({ regex: "foo\\(\\n\\s+bar", context: 0 })).toMatchObject({
      total_matches: 1,
      results: "## multi.txt (1 match)\n> 2 | function foo(\n  bar\n---",
    });
    expect(await run({ regex: "absent" })).toEqual({
      total_matches: 0,
      truncated: false,
      results: "No results found",
    });

    await fs.rm(root, { recursive: true, force: true });
  });
});
