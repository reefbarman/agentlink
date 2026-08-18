import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  AgentPluginInstaller,
  validateAgentPluginArchiveSymlinkTarget,
} from "./AgentPluginInstaller.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_PLUGIN_MANIFEST_SCHEMA_ID } from "../core/agentPlugins/schemaRegistry.js";
import { ZipFile } from "yazl";

async function writePlugin(root: string, name: string): Promise<void> {
  await fs.mkdir(path.join(root, "skills", "helper"), { recursive: true });
  await fs.writeFile(
    path.join(root, "plugin.json"),
    `${JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_ID, name })}\n`,
  );
  await fs.writeFile(
    path.join(root, "skills", "helper", "SKILL.md"),
    "---\nname: helper\ndescription: Helps.\n---\n\nHelp.\n",
  );
}

async function writeZip(
  target: string,
  entries: readonly { name: string; content: string }[],
): Promise<void> {
  const archive = new ZipFile();
  for (const entry of entries) {
    archive.addBuffer(Buffer.from(entry.content), entry.name);
  }
  archive.end();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const handle = await fs.open(target, "w");
  try {
    for await (const chunk of archive.outputStream) {
      await handle.write(chunk as Buffer);
    }
  } finally {
    await handle.close();
  }
}

async function replaceZipEntryName(
  archivePath: string,
  from: string,
  to: string,
): Promise<void> {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) {
    throw new Error(
      "ZIP fixture entry-name replacements must have equal length",
    );
  }
  const archive = await fs.readFile(archivePath);
  const source = Buffer.from(from);
  const replacement = Buffer.from(to);
  let offset = 0;
  let replacements = 0;
  while ((offset = archive.indexOf(source, offset)) >= 0) {
    replacement.copy(archive, offset);
    offset += replacement.length;
    replacements++;
  }
  if (replacements < 2) {
    throw new Error(
      "ZIP fixture did not contain local and central entry names",
    );
  }
  await fs.writeFile(archivePath, archive);
}

describe("AgentPluginInstaller", () => {
  let directory: string;
  let staging: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-plugin-installer-"),
    );
    staging = path.join(directory, "staging");
    await fs.mkdir(staging);
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("imports a local directory into unique staging and discovers a plugin", async () => {
    const source = path.join(directory, "source");
    await writePlugin(source, "local-fixture");
    const installer = new AgentPluginInstaller({ stagingParent: staging });

    const acquired = await installer.acquire({
      kind: "local-directory",
      path: source,
      display: "source",
    });
    try {
      expect(acquired.materializedRoot).not.toBe(source);
      expect(acquired.provenance).toMatchObject({
        kind: "local-directory",
        label: "source",
      });
      expect(acquired.candidates).toHaveLength(1);
      expect(acquired.candidates[0]?.snapshot.manifest?.name).toBe(
        "local-fixture",
      );
    } finally {
      await acquired.cleanup();
    }
    await expect(fs.stat(acquired.stagingRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("discovers independently validated plugins in a collection ZIP", async () => {
    const archivePath = path.join(directory, "collection.zip");
    const manifest = (name: string) =>
      `${JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_ID, name })}\n`;
    await writeZip(archivePath, [
      { name: "one/plugin.json", content: manifest("one") },
      {
        name: "one/skills/helper/SKILL.md",
        content: "---\nname: helper\ndescription: One.\n---\n",
      },
      { name: "two/plugin.json", content: manifest("two") },
      {
        name: "two/skills/helper/SKILL.md",
        content: "---\nname: helper\ndescription: Two.\n---\n",
      },
    ]);
    const installer = new AgentPluginInstaller({ stagingParent: staging });

    const acquired = await installer.acquire({
      kind: "local-archive",
      path: archivePath,
      display: "collection.zip",
    });
    try {
      expect(
        acquired.candidates.map(
          (candidate) => candidate.snapshot.manifest?.name,
        ),
      ).toEqual(["one", "two"]);
      expect(
        acquired.candidates.map((candidate) => candidate.relativePath),
      ).toEqual(["one", "two"]);
    } finally {
      await acquired.cleanup();
    }
  });

  it("rejects ZIP traversal and removes partial staging", async () => {
    const archivePath = path.join(directory, "unsafe.zip");
    await writeZip(archivePath, [{ name: "aa/escape.txt", content: "escape" }]);
    await replaceZipEntryName(archivePath, "aa/escape.txt", "../escape.txt");
    const installer = new AgentPluginInstaller({ stagingParent: staging });

    await expect(
      installer.acquire({
        kind: "local-archive",
        path: archivePath,
        display: "unsafe.zip",
      }),
    ).rejects.toMatchObject({ code: "archive_unsafe" });
    await expect(fs.readdir(staging)).resolves.toEqual([]);
    await expect(
      fs.stat(path.join(directory, "escape.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects ambiguous plaintext HTTP sources that are not archives", async () => {
    const installer = new AgentPluginInstaller({
      stagingParent: staging,
      fetch: async () =>
        new Response("not an archive", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    });

    await expect(
      installer.acquire({
        kind: "remote",
        url: "http://downloads.example.net/plugin",
        display: "http://downloads.example.net/plugin",
        hint: "unknown",
      }),
    ).rejects.toMatchObject({
      code: "unsupported_remote",
      message: expect.stringContaining("Git remotes must use HTTPS or SSH"),
    });
    await expect(fs.readdir(staging)).resolves.toEqual([]);
  });

  it("rejects Git archive symlinks that escape the staged package", () => {
    expect(() =>
      validateAgentPluginArchiveSymlinkTarget(
        "skills/helper/link",
        "../../../outside",
        "/tmp/plugin-stage",
      ),
    ).toThrow(expect.objectContaining({ code: "archive_unsafe" }));
    expect(() =>
      validateAgentPluginArchiveSymlinkTarget(
        "skills/helper/link",
        "/etc/passwd",
        "/tmp/plugin-stage",
      ),
    ).toThrow(expect.objectContaining({ code: "archive_unsafe" }));
    expect(() =>
      validateAgentPluginArchiveSymlinkTarget(
        "skills/helper/link",
        "../reference.md",
        "/tmp/plugin-stage",
      ),
    ).not.toThrow();
  });

  it("rejects case-colliding archive output", async () => {
    const archivePath = path.join(directory, "collision.zip");
    await writeZip(archivePath, [
      { name: "plugin.json", content: "{}" },
      { name: "PLUGIN.JSON", content: "{}" },
    ]);
    const installer = new AgentPluginInstaller({ stagingParent: staging });

    await expect(
      installer.acquire({
        kind: "local-archive",
        path: archivePath,
        display: "collision.zip",
      }),
    ).rejects.toMatchObject({ code: "archive_unsafe" });
  });
});
