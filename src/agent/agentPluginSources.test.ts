import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseAgentPluginSource,
  parsePluginCommandArgs,
  sanitizeRemoteDisplay,
} from "./agentPluginSources.js";

import { pathToFileURL } from "node:url";

describe("parseAgentPluginSource", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-plugin-source-"),
    );
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("accepts broad Git remote forms without a host allowlist", async () => {
    await expect(
      parseAgentPluginSource("https://git.example.net/team/plugin.git"),
    ).resolves.toMatchObject({ kind: "remote", hint: "git" });
    await expect(
      parseAgentPluginSource("ssh://git@git.example.net/team/plugin"),
    ).resolves.toMatchObject({
      kind: "git",
      remote: "ssh://git@git.example.net/team/plugin",
      display: "ssh://git@git.example.net/team/plugin",
    });
    await expect(
      parseAgentPluginSource("git@git.example.net:team/plugin.git", {
        ref: "release/v1",
      }),
    ).resolves.toMatchObject({
      kind: "git",
      remote: "git@git.example.net:team/plugin.git",
      ref: "release/v1",
    });
    await expect(
      parseAgentPluginSource("git+https://git.example.net/team/plugin"),
    ).resolves.toMatchObject({ kind: "git" });
  });

  it("classifies HTTP archives and keeps ambiguous URLs for content inspection", async () => {
    await expect(
      parseAgentPluginSource(
        "https://downloads.example.net/plugin.TGZ?release=1",
      ),
    ).resolves.toMatchObject({ kind: "remote", hint: "archive" });
    await expect(
      parseAgentPluginSource("https://downloads.example.net/latest"),
    ).resolves.toMatchObject({ kind: "remote", hint: "unknown" });
  });

  it("accepts directories, plugin manifests, archives, and file URLs", async () => {
    const plugin = path.join(directory, "plugin");
    const archive = path.join(directory, "plugin.zip");
    await fs.mkdir(plugin);
    await fs.writeFile(path.join(plugin, "plugin.json"), "{}\n");
    await fs.writeFile(archive, "zip fixture");

    await expect(parseAgentPluginSource(plugin)).resolves.toMatchObject({
      kind: "local-directory",
      path: plugin,
    });
    await expect(
      parseAgentPluginSource(path.join(plugin, "plugin.json")),
    ).resolves.toMatchObject({ kind: "local-directory", path: plugin });
    await expect(parseAgentPluginSource(archive)).resolves.toMatchObject({
      kind: "local-archive",
      path: archive,
    });
    await expect(
      parseAgentPluginSource(pathToFileURL(archive).toString()),
    ).resolves.toMatchObject({ kind: "local-archive", path: archive });
  });

  it("rejects embedded credentials, fragments, unsafe refs, and unknown protocols", async () => {
    await expect(
      parseAgentPluginSource("https://user:secret@example.net/plugin.zip"),
    ).rejects.toMatchObject({ code: "invalid_source" });
    await expect(
      parseAgentPluginSource("https://example.net/plugin.zip#subdir"),
    ).rejects.toMatchObject({ code: "invalid_source" });
    await expect(
      parseAgentPluginSource("git@example.net:team/plugin.git", {
        ref: "--upload-pack",
      }),
    ).rejects.toMatchObject({ code: "invalid_git_ref" });
    await expect(
      parseAgentPluginSource("ftp://example.net/plugin.zip"),
    ).rejects.toMatchObject({ code: "unsupported_protocol" });
    await expect(
      parseAgentPluginSource("http://git.example.net/team/plugin.git"),
    ).rejects.toMatchObject({ code: "unsupported_protocol" });
    await expect(
      parseAgentPluginSource("git+http://git.example.net/team/plugin"),
    ).rejects.toMatchObject({ code: "unsupported_protocol" });
    await expect(
      parseAgentPluginSource("ssh://git@git.example.net/team/plugin#release"),
    ).rejects.toMatchObject({ code: "invalid_source" });
  });
});

describe("parsePluginCommandArgs", () => {
  it("parses management verbs, quoted sources, and explicit refs", () => {
    expect(
      parsePluginCommandArgs(
        'install "https://git.example.net/team/plugin.git" --ref release/v1',
      ),
    ).toEqual({
      action: "install",
      operand: "https://git.example.net/team/plugin.git",
      ref: "release/v1",
    });
    expect(parsePluginCommandArgs(" ")).toEqual({
      action: "list",
      operand: "",
    });
    expect(parsePluginCommandArgs("install --ref v2 ./plugin")).toEqual({
      action: "install",
      operand: "./plugin",
      ref: "v2",
    });
    expect(parsePluginCommandArgs("disable example-plugin")).toEqual({
      action: "disable",
      operand: "example-plugin",
    });
  });

  it("scrubs URL credentials/fragments while retaining SCP transport users", () => {
    expect(
      sanitizeRemoteDisplay("https://user:secret@example.net/plugin.git#ref"),
    ).toBe("https://example.net/plugin.git");
    expect(sanitizeRemoteDisplay("git@example.net:team/plugin.git")).toBe(
      "git@example.net:team/plugin.git",
    );
    expect(
      sanitizeRemoteDisplay(
        "ssh://git:secret@git.example.net/team/plugin.git#release",
      ),
    ).toBe("ssh://git@git.example.net/team/plugin.git");
  });
});
