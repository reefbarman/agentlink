import type { SessionProjectScope } from "../core/workspaceProjects.js";
import { McpClientHub } from "./McpClientHub.js";
import { loadMcpConfigs, type McpServerConfig } from "./mcpConfig.js";

export interface ManagedProjectMcpHub {
  connect(
    configs: McpServerConfig[],
    options?: { interactiveForNewServers?: boolean },
  ): Promise<void>;
  disconnectAll(): Promise<void>;
}

export interface ProjectMcpHubLease<
  THub extends ManagedProjectMcpHub = McpClientHub,
> {
  readonly projectId: string;
  readonly generation: number;
  readonly hub: THub;
  retain(): ProjectMcpHubLease<THub>;
  release(): void;
}

export interface ProjectMcpHubGeneration<
  THub extends ManagedProjectMcpHub = McpClientHub,
> {
  readonly projectId: string;
  readonly generation: number;
  readonly hub: THub;
}

export interface ProjectMcpHubRegistryOptions<
  THub extends ManagedProjectMcpHub = McpClientHub,
> {
  createHub?: (
    scope: Readonly<SessionProjectScope>,
    generation: number,
  ) => THub;
  loadConfigs?: (
    scope: Readonly<SessionProjectScope>,
  ) => Promise<McpServerConfig[]>;
  configureHub?: (
    hub: THub,
    scope: Readonly<SessionProjectScope>,
    generation: number,
  ) => void;
  onError?: (error: unknown, projectId: string) => void;
}

interface HubGeneration<THub extends ManagedProjectMcpHub> {
  readonly generation: number;
  readonly hub: THub;
  leases: number;
  retired: boolean;
  disconnectPromise?: Promise<void>;
}

interface ProjectEntry<THub extends ManagedProjectMcpHub> {
  readonly workspaceFolderUri: string;
  readonly rootPath: string;
  nextGeneration: number;
  current?: HubGeneration<THub>;
  reloadQueue: Promise<ProjectMcpHubGeneration<THub>>;
  retired: boolean;
}

export class ProjectMcpHubRegistry<
  THub extends ManagedProjectMcpHub = McpClientHub,
> {
  private readonly entries = new Map<string, ProjectEntry<THub>>();
  private readonly createHub: NonNullable<
    ProjectMcpHubRegistryOptions<THub>["createHub"]
  >;
  private readonly loadConfigs: NonNullable<
    ProjectMcpHubRegistryOptions<THub>["loadConfigs"]
  >;

  constructor(
    private readonly options: ProjectMcpHubRegistryOptions<THub> = {},
  ) {
    this.createHub =
      options.createHub ??
      (((_scope: Readonly<SessionProjectScope>, generation: number) =>
        new McpClientHub(
          undefined,
          `project-mcp-${generation}`,
        )) as unknown as NonNullable<
        ProjectMcpHubRegistryOptions<THub>["createHub"]
      >);
    this.loadConfigs =
      options.loadConfigs ??
      (async (scope) => loadMcpConfigs(this.requireRoot(scope)));
  }

  ensure(scope: Readonly<SessionProjectScope>): ProjectMcpHubGeneration<THub> {
    const entry = this.getOrCreateEntry(scope);
    if (!entry.current) {
      const hub = this.createHub(scope, 0);
      entry.current = {
        generation: 0,
        hub,
        leases: 0,
        retired: false,
      };
      this.options.configureHub?.(hub, scope, 0);
    }
    return {
      projectId: scope.projectId,
      generation: entry.current.generation,
      hub: entry.current.hub,
    };
  }

  async reload(
    scope: Readonly<SessionProjectScope>,
    options: { interactiveForNewServers?: boolean } = {},
  ): Promise<ProjectMcpHubGeneration<THub>> {
    const entry = this.getOrCreateEntry(scope);
    const run = entry.reloadQueue
      .catch(() => undefined)
      .then(() => this.replaceGeneration(scope, entry, options));
    entry.reloadQueue = run;
    return run;
  }

  getCurrent(
    scope: Readonly<SessionProjectScope>,
  ): ProjectMcpHubGeneration<THub> | undefined {
    const entry = this.entries.get(scope.projectId);
    if (!entry) return undefined;
    this.assertScopeMatchesEntry(scope, entry);
    const current = entry.current;
    if (!current) return undefined;
    return {
      projectId: scope.projectId,
      generation: current.generation,
      hub: current.hub,
    };
  }

  acquire(scope: Readonly<SessionProjectScope>): ProjectMcpHubLease<THub> {
    const entry = this.entries.get(scope.projectId);
    if (!entry) {
      throw new Error(
        `MCP is not initialized for project '${scope.displayName}'.`,
      );
    }
    this.assertScopeMatchesEntry(scope, entry);
    const current = entry.current;
    if (!current) {
      throw new Error(
        `MCP is not initialized for project '${scope.displayName}'.`,
      );
    }
    return this.createLease(scope.projectId, current);
  }

  async retireProject(projectId: string): Promise<void> {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    this.entries.delete(projectId);
    entry.retired = true;
    await entry.reloadQueue.catch(() => undefined);
    if (entry.current) {
      entry.current.retired = true;
      await this.disconnectWhenDrained(projectId, entry.current);
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(
      Array.from(this.entries.keys()).map((projectId) =>
        this.retireProject(projectId),
      ),
    );
  }

  private async replaceGeneration(
    scope: Readonly<SessionProjectScope>,
    entry: ProjectEntry<THub>,
    options: { interactiveForNewServers?: boolean },
  ): Promise<ProjectMcpHubGeneration<THub>> {
    this.assertScopeMatchesEntry(scope, entry);
    const generation = entry.nextGeneration++;
    const hub = this.createHub(scope, generation);

    try {
      const configs = await this.loadConfigs(scope);
      await hub.connect(configs, options);
      if (entry.retired) {
        throw new Error(
          `MCP project '${scope.displayName}' was retired during reload.`,
        );
      }
    } catch (error) {
      try {
        await hub.disconnectAll();
      } catch (disconnectError) {
        this.options.onError?.(disconnectError, scope.projectId);
      }
      throw error;
    }

    const next: HubGeneration<THub> = {
      generation,
      hub,
      leases: 0,
      retired: false,
    };
    const previous = entry.current;
    entry.current = next;
    this.options.configureHub?.(hub, scope, generation);
    if (previous) {
      previous.retired = true;
      void this.disconnectWhenDrained(scope.projectId, previous);
    }
    return { projectId: scope.projectId, generation, hub };
  }

  private createLease(
    projectId: string,
    generation: HubGeneration<THub>,
  ): ProjectMcpHubLease<THub> {
    generation.leases += 1;
    let released = false;
    return {
      projectId,
      generation: generation.generation,
      hub: generation.hub,
      retain: () => {
        if (released) {
          throw new Error("Cannot retain a released MCP hub lease.");
        }
        return this.createLease(projectId, generation);
      },
      release: () => {
        if (released) return;
        released = true;
        generation.leases -= 1;
        if (generation.retired && generation.leases === 0) {
          void this.disconnectWhenDrained(projectId, generation);
        }
      },
    };
  }

  private disconnectWhenDrained(
    projectId: string,
    generation: HubGeneration<THub>,
  ): Promise<void> {
    if (generation.leases > 0) return Promise.resolve();
    generation.disconnectPromise ??= generation.hub
      .disconnectAll()
      .catch((error) => {
        this.options.onError?.(error, projectId);
      });
    return generation.disconnectPromise;
  }

  private getOrCreateEntry(
    scope: Readonly<SessionProjectScope>,
  ): ProjectEntry<THub> {
    const rootPath = this.requireRoot(scope);
    const existing = this.entries.get(scope.projectId);
    if (existing) {
      this.assertScopeMatchesEntry(scope, existing);
      return existing;
    }
    const entry: ProjectEntry<THub> = {
      workspaceFolderUri: scope.workspaceFolderUri,
      rootPath,
      nextGeneration: 1,
      reloadQueue: Promise.resolve(undefined as never),
      retired: false,
    };
    this.entries.set(scope.projectId, entry);
    return entry;
  }

  private assertScopeMatchesEntry(
    scope: Readonly<SessionProjectScope>,
    entry: ProjectEntry<THub>,
  ): void {
    if (
      scope.workspaceFolderUri !== entry.workspaceFolderUri ||
      this.requireRoot(scope) !== entry.rootPath
    ) {
      throw new Error(
        `Project '${scope.projectId}' cannot be rebound to a different MCP root.`,
      );
    }
  }

  private requireRoot(scope: Readonly<SessionProjectScope>): string {
    if (!scope.rootPath) {
      throw new Error(
        `Project '${scope.displayName}' is unavailable for MCP connections.`,
      );
    }
    return scope.rootPath;
  }
}
