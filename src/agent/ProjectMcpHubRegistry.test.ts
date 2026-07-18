import { describe, expect, it, vi } from "vitest";

import type { SessionProjectScope } from "../core/workspaceProjects.js";
import type { McpServerConfig } from "./mcpConfig.js";
import {
  ProjectMcpHubRegistry,
  type ManagedProjectMcpHub,
} from "./ProjectMcpHubRegistry.js";

class FakeHub implements ManagedProjectMcpHub {
  readonly connect = vi.fn(async (_configs: McpServerConfig[]) => undefined);
  readonly disconnectAll = vi.fn(async () => undefined);

  constructor(
    readonly projectId: string,
    readonly generation: number,
  ) {}
}

function scope(projectId: string, rootPath: string): SessionProjectScope {
  return {
    schemaVersion: 1,
    kind: "project",
    projectId,
    workspaceFolderUri: `file://${rootPath}`,
    displayName: projectId,
    rootPath,
  };
}

describe("ProjectMcpHubRegistry", () => {
  it("isolates conflicting server names by project", async () => {
    const projectA = scope("project-a", "/workspace/a");
    const projectB = scope("project-b", "/workspace/b");
    const configs = new Map<string, McpServerConfig[]>([
      [projectA.projectId, [{ name: "shared", command: "server-a" }]],
      [projectB.projectId, [{ name: "shared", command: "server-b" }]],
    ]);
    const registry = new ProjectMcpHubRegistry<FakeHub>({
      createHub: (project, generation) =>
        new FakeHub(project.projectId, generation),
      loadConfigs: async (project) => configs.get(project.projectId) ?? [],
    });

    const a = await registry.reload(projectA);
    const b = await registry.reload(projectB);

    expect(a.hub).not.toBe(b.hub);
    expect(a.hub.connect).toHaveBeenCalledWith(
      [{ name: "shared", command: "server-a" }],
      {},
    );
    expect(b.hub.connect).toHaveBeenCalledWith(
      [{ name: "shared", command: "server-b" }],
      {},
    );
  });

  it("provides a project-isolated empty generation before async loading completes", async () => {
    const project = scope("project-a", "/workspace/a");
    const hubs: FakeHub[] = [];
    const registry = new ProjectMcpHubRegistry<FakeHub>({
      createHub: (projectScope, generation) => {
        const hub = new FakeHub(projectScope.projectId, generation);
        hubs.push(hub);
        return hub;
      },
      loadConfigs: async () => [],
    });

    const initial = registry.ensure(project);
    const lease = registry.acquire(project);

    expect(initial.generation).toBe(0);
    expect(lease.hub).toBe(initial.hub);
    expect(initial.hub.connect).not.toHaveBeenCalled();

    await registry.reload(project);
    expect(initial.hub.disconnectAll).not.toHaveBeenCalled();

    lease.release();
    await vi.waitFor(() => {
      expect(initial.hub.disconnectAll).toHaveBeenCalledOnce();
    });
  });

  it("keeps a retired generation connected until every retained lease drains", async () => {
    const project = scope("project-a", "/workspace/a");
    const hubs: FakeHub[] = [];
    const registry = new ProjectMcpHubRegistry<FakeHub>({
      createHub: (projectScope, generation) => {
        const hub = new FakeHub(projectScope.projectId, generation);
        hubs.push(hub);
        return hub;
      },
      loadConfigs: async () => [],
    });

    await registry.reload(project);
    const requestLease = registry.acquire(project);
    const childLease = requestLease.retain();
    const replacement = await registry.reload(project);

    expect(replacement.generation).toBe(2);
    expect(requestLease.generation).toBe(1);
    expect(hubs[0].disconnectAll).not.toHaveBeenCalled();

    requestLease.release();
    expect(hubs[0].disconnectAll).not.toHaveBeenCalled();

    childLease.release();
    await vi.waitFor(() => {
      expect(hubs[0].disconnectAll).toHaveBeenCalledOnce();
    });

    childLease.release();
    expect(hubs[0].disconnectAll).toHaveBeenCalledOnce();
  });

  it("does not replace the current generation when a reload fails", async () => {
    const project = scope("project-a", "/workspace/a");
    const hubs: FakeHub[] = [];
    let fail = false;
    const registry = new ProjectMcpHubRegistry<FakeHub>({
      createHub: (projectScope, generation) => {
        const hub = new FakeHub(projectScope.projectId, generation);
        if (fail)
          hub.connect.mockRejectedValueOnce(new Error("connect failed"));
        hubs.push(hub);
        return hub;
      },
      loadConfigs: async () => [],
    });

    const first = await registry.reload(project);
    fail = true;
    await expect(registry.reload(project)).rejects.toThrow("connect failed");

    expect(registry.getCurrent(project)).toEqual(first);
    expect(hubs[0].disconnectAll).not.toHaveBeenCalled();
    expect(hubs[1].disconnectAll).toHaveBeenCalledOnce();
  });

  it("disconnects an in-flight replacement when its project is retired", async () => {
    const project = scope("project-a", "/workspace/a");
    let resolveConfigs: ((configs: McpServerConfig[]) => void) | undefined;
    const configs = new Promise<McpServerConfig[]>((resolve) => {
      resolveConfigs = resolve;
    });
    const hubs: FakeHub[] = [];
    const registry = new ProjectMcpHubRegistry<FakeHub>({
      createHub: (projectScope, generation) => {
        const hub = new FakeHub(projectScope.projectId, generation);
        hubs.push(hub);
        return hub;
      },
      loadConfigs: async () => configs,
    });

    const reload = registry.reload(project);
    const retirement = registry.retireProject(project.projectId);
    resolveConfigs?.([]);

    await expect(reload).rejects.toThrow("was retired during reload");
    await retirement;
    expect(hubs[0].disconnectAll).toHaveBeenCalledOnce();
    expect(registry.getCurrent(project)).toBeUndefined();
  });

  it("retires one project without affecting another", async () => {
    const projectA = scope("project-a", "/workspace/a");
    const projectB = scope("project-b", "/workspace/b");
    const hubs = new Map<string, FakeHub>();
    const registry = new ProjectMcpHubRegistry<FakeHub>({
      createHub: (project, generation) => {
        const hub = new FakeHub(project.projectId, generation);
        hubs.set(project.projectId, hub);
        return hub;
      },
      loadConfigs: async () => [],
    });

    await registry.reload(projectA);
    await registry.reload(projectB);
    await registry.retireProject(projectA.projectId);

    expect(hubs.get(projectA.projectId)?.disconnectAll).toHaveBeenCalledOnce();
    expect(hubs.get(projectB.projectId)?.disconnectAll).not.toHaveBeenCalled();
    expect(registry.getCurrent(projectB)?.hub).toBe(
      hubs.get(projectB.projectId),
    );
  });

  it("rejects rebinding a stable project ID to another root", async () => {
    const project = scope("project-a", "/workspace/a");
    const registry = new ProjectMcpHubRegistry<FakeHub>({
      createHub: (projectScope, generation) =>
        new FakeHub(projectScope.projectId, generation),
      loadConfigs: async () => [],
    });

    await registry.reload(project);

    expect(() =>
      registry.acquire({
        ...project,
        workspaceFolderUri: "file:///workspace/other",
        rootPath: "/workspace/other",
      }),
    ).toThrow("cannot be rebound");
  });
});
