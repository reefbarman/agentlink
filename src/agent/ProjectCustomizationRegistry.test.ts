import { describe, expect, it, vi } from "vitest";

import type { AgentMode } from "./modes.js";
import { ProjectCustomizationRegistry } from "./ProjectCustomizationRegistry.js";
import type { SessionProjectScope } from "@agentlink/protocol/workspace-project";
import type { SlashCommand } from "./SlashCommandRegistry.js";

function scope(
  projectId: string,
  rootPath: string | undefined,
): SessionProjectScope {
  return {
    schemaVersion: 1,
    kind: "project",
    projectId,
    workspaceFolderUri: `file://${rootPath ?? `/missing/${projectId}`}`,
    displayName: projectId,
    rootPath,
  };
}

function command(name: string, body: string): SlashCommand {
  return {
    name,
    description: name,
    source: "project",
    builtin: false,
    body,
  };
}

function mode(slug: string, name: string): AgentMode {
  return {
    slug,
    name,
    icon: "symbol-misc",
    toolGroups: ["read"],
  };
}

describe("ProjectCustomizationRegistry", () => {
  it("isolates conflicting modes and slash commands by project", async () => {
    const loadCustomModes = vi.fn(async (rootPath: string) => [
      mode("custom", rootPath === "/project-a" ? "Mode A" : "Mode B"),
    ]);
    const loadSlashCommands = vi.fn(
      async (rootPath: string, requestedMode: string) => [
        command("conflict", `${rootPath}:${requestedMode}`),
      ],
    );
    const registry = new ProjectCustomizationRegistry({
      loadCustomModes,
      loadSlashCommands,
    });

    const projectA = scope("project-a", "/project-a");
    const projectB = scope("project-b", "/project-b");

    await expect(registry.getModes(projectA)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "custom", name: "Mode A" }),
      ]),
    );
    await expect(registry.getModes(projectB)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "custom", name: "Mode B" }),
      ]),
    );
    await expect(registry.getSlashCommands(projectA, "code")).resolves.toEqual([
      expect.objectContaining({ name: "conflict", body: "/project-a:code" }),
    ]);
    await expect(registry.getSlashCommands(projectB, "code")).resolves.toEqual([
      expect.objectContaining({ name: "conflict", body: "/project-b:code" }),
    ]);
  });

  it("caches slash commands per mode within a project", async () => {
    const loadSlashCommands = vi.fn(
      async (_rootPath: string, requestedMode: string) => [
        command(`skill:${requestedMode}`, requestedMode),
      ],
    );
    const registry = new ProjectCustomizationRegistry({
      loadCustomModes: vi.fn(async () => []),
      loadSlashCommands,
    });
    const project = scope("project-a", "/project-a");

    await registry.getSlashCommands(project, "code");
    await registry.getSlashCommands(project, "code");
    await registry.getSlashCommands(project, "ask");

    expect(loadSlashCommands).toHaveBeenCalledTimes(2);
    expect(loadSlashCommands).toHaveBeenNthCalledWith(
      1,
      "/project-a",
      "code",
      [],
    );
    expect(loadSlashCommands).toHaveBeenNthCalledWith(
      2,
      "/project-a",
      "ask",
      [],
    );
  });

  it("refreshes generated commands when the disabled skill policy changes", async () => {
    let disabledSkillIds: string[] = [];
    const loadSlashCommands = vi.fn(
      async (_rootPath: string, _mode: string, disabled: readonly string[]) => [
        command("policy", disabled.join(",")),
      ],
    );
    const registry = new ProjectCustomizationRegistry(
      {
        loadCustomModes: vi.fn(async () => []),
        loadSlashCommands,
      },
      () => disabledSkillIds,
    );
    const project = scope("project-a", "/project-a");

    await expect(registry.getSlashCommands(project, "code")).resolves.toEqual([
      expect.objectContaining({ body: "" }),
    ]);
    disabledSkillIds = ["project:agentlink:.agentlink/skills/helper"];
    await expect(registry.getSlashCommands(project, "code")).resolves.toEqual([
      expect.objectContaining({
        body: "project:agentlink:.agentlink/skills/helper",
      }),
    ]);

    expect(loadSlashCommands).toHaveBeenCalledTimes(2);
    expect(loadSlashCommands).toHaveBeenLastCalledWith("/project-a", "code", [
      "project:agentlink:.agentlink/skills/helper",
    ]);
  });

  it("invalidates only the selected project", async () => {
    const loadCustomModes = vi.fn(async (rootPath: string) => [
      mode("custom", rootPath),
    ]);
    const registry = new ProjectCustomizationRegistry({
      loadCustomModes,
      loadSlashCommands: vi.fn(async () => []),
    });
    const projectA = scope("project-a", "/project-a");
    const projectB = scope("project-b", "/project-b");

    await registry.getModes(projectA);
    await registry.getModes(projectB);
    registry.invalidate(projectA.projectId);
    await registry.getModes(projectA);
    await registry.getModes(projectB);

    expect(loadCustomModes).toHaveBeenCalledTimes(3);
    expect(loadCustomModes).toHaveBeenNthCalledWith(3, "/project-a");
  });

  it("rejects unavailable scopes and identity changes without invalidation", async () => {
    const registry = new ProjectCustomizationRegistry({
      loadCustomModes: vi.fn(async () => []),
      loadSlashCommands: vi.fn(async () => []),
    });

    await expect(
      registry.getModes(scope("missing", undefined)),
    ).rejects.toThrow("unavailable for customization loading");

    const initial = scope("project-a", "/project-a");
    await registry.getModes(initial);
    await expect(
      registry.getModes({
        ...initial,
        rootPath: "/project-a-moved",
      }),
    ).rejects.toThrow("changed without invalidation");
  });
});
