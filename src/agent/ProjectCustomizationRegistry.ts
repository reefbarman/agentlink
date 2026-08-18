import type { SessionProjectScope } from "../core/workspaceProjects.js";
import {
  SlashCommandRegistry,
  type SlashCommand,
} from "./SlashCommandRegistry.js";
import { getAllModes, loadCustomModes, type AgentMode } from "./modes.js";
import type { AgentPluginCatalogProvider } from "./AgentPluginCatalog.js";

interface ProjectCustomizationEntry {
  workspaceFolderUri: string;
  rootPath: string;
  modes?: Promise<readonly AgentMode[]>;
  slashCommandsByMode: Map<string, Promise<readonly SlashCommand[]>>;
}

export interface ProjectCustomizationRegistryDependencies {
  loadCustomModes(rootPath: string): Promise<AgentMode[]>;
  loadSlashCommands(
    rootPath: string,
    mode: string,
    disabledSkillIds: readonly string[],
    context?: {
      readonly scope: Readonly<SessionProjectScope>;
      readonly agentPluginCatalogProvider?: AgentPluginCatalogProvider;
    },
  ): Promise<SlashCommand[]>;
}

const defaultDependencies: ProjectCustomizationRegistryDependencies = {
  loadCustomModes,
  async loadSlashCommands(rootPath, mode, disabledSkillIds, context) {
    const registry = new SlashCommandRegistry(
      rootPath,
      mode,
      disabledSkillIds,
      context?.scope,
      context?.agentPluginCatalogProvider,
    );
    await registry.reload();
    return registry.getAll();
  },
};

/**
 * Caches project-local modes, slash commands, and generated skill commands by
 * immutable session project identity. Entries are invalidated per project so a
 * customization change in one workspace folder cannot affect another folder.
 */
export class ProjectCustomizationRegistry {
  private readonly entries = new Map<string, ProjectCustomizationEntry>();

  constructor(
    private readonly dependencies: ProjectCustomizationRegistryDependencies = defaultDependencies,
    private readonly getDisabledSkillIds: (
      scope: SessionProjectScope,
    ) => readonly string[] = () => [],
    private readonly agentPluginCatalogProvider?: AgentPluginCatalogProvider,
  ) {}

  async getModes(scope: SessionProjectScope): Promise<AgentMode[]> {
    const entry = this.getEntry(scope);
    entry.modes ??= this.dependencies
      .loadCustomModes(entry.rootPath)
      .then((customModes) =>
        Object.freeze(getAllModes(customModes).map(cloneMode)),
      );
    return (await entry.modes).map(cloneMode);
  }

  async getSlashCommands(
    scope: SessionProjectScope,
    mode: string,
  ): Promise<SlashCommand[]> {
    const entry = this.getEntry(scope);
    const disabledSkillIds = [...this.getDisabledSkillIds(scope)].sort();
    const cacheKey = `${mode}\0${disabledSkillIds.join("\0")}`;
    let commands = entry.slashCommandsByMode.get(cacheKey);
    if (!commands) {
      const loaded = this.agentPluginCatalogProvider
        ? this.dependencies.loadSlashCommands(
            entry.rootPath,
            mode,
            disabledSkillIds,
            {
              scope,
              agentPluginCatalogProvider: this.agentPluginCatalogProvider,
            },
          )
        : this.dependencies.loadSlashCommands(
            entry.rootPath,
            mode,
            disabledSkillIds,
          );
      commands = loaded.then((items) =>
        Object.freeze(items.map(cloneSlashCommand)),
      );
      entry.slashCommandsByMode.set(cacheKey, commands);
    }
    return (await commands).map(cloneSlashCommand);
  }

  async getSkillCommands(
    scope: SessionProjectScope,
    mode: string,
  ): Promise<SlashCommand[]> {
    const commands = await this.getSlashCommands(scope, mode);
    return commands.filter((command) => command.source === "skill");
  }

  invalidate(projectId: string): void {
    this.entries.delete(projectId);
  }

  clear(): void {
    this.entries.clear();
  }

  private getEntry(scope: SessionProjectScope): ProjectCustomizationEntry {
    if (!scope.rootPath) {
      throw new Error(
        `Project '${scope.displayName}' is unavailable for customization loading.`,
      );
    }

    const existing = this.entries.get(scope.projectId);
    if (existing) {
      // A stable project ID must never be rebound to a different execution root
      // implicitly. Catalog refresh/removal code must invalidate explicitly so an
      // older session cannot start reading a replacement folder's customizations.
      if (
        existing.workspaceFolderUri !== scope.workspaceFolderUri ||
        existing.rootPath !== scope.rootPath
      ) {
        throw new Error(
          `Project customization scope changed without invalidation for '${scope.projectId}'.`,
        );
      }
      return existing;
    }

    const entry: ProjectCustomizationEntry = {
      workspaceFolderUri: scope.workspaceFolderUri,
      rootPath: scope.rootPath,
      slashCommandsByMode: new Map(),
    };
    this.entries.set(scope.projectId, entry);
    return entry;
  }
}

function cloneMode(mode: AgentMode): AgentMode {
  return { ...mode, toolGroups: [...mode.toolGroups] };
}

function cloneSlashCommand(command: SlashCommand): SlashCommand {
  return { ...command };
}
