import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  HookDiagnostic,
  HookSourceDefinition,
  HookTrustRequest,
} from "../core/hooks/contracts.js";

import type { AgentPluginCatalogProvider } from "./AgentPluginCatalog.js";
import type { ConfigStore } from "../approvals/ConfigStore.js";
import { HookRuntime } from "../core/hooks/HookRuntime.js";
import type { OnApprovalRequest } from "../shared/types.js";
import type { SessionProjectScope } from "../core/workspaceProjects.js";
import { parseHookSources } from "../core/hooks/hookConfig.js";

const HOOK_NAMESPACES = [".agents", ".claude", ".codex", ".agentlink"] as const;
const MAX_HOOK_SOURCE_BYTES = 1024 * 1024;

export interface HookRuntimeProvider {
  getRuntime(
    scope: Readonly<SessionProjectScope>,
    sessionId: string,
  ): Promise<HookRuntime>;
  invalidate(projectId?: string): void;
}

export interface HookServiceOptions {
  readonly configStore: ConfigStore;
  readonly pluginCatalog?: AgentPluginCatalogProvider;
  readonly onApprovalRequest?: OnApprovalRequest;
  readonly log?: (message: string) => void;
  readonly homeDirectory?: string;
}

export class HookService implements HookRuntimeProvider {
  private readonly cache = new Map<
    string,
    Promise<ReturnType<typeof parseHookSources>>
  >();
  private readonly pendingTrust = new Map<string, Promise<boolean>>();

  constructor(private readonly options: HookServiceOptions) {}

  invalidate(projectId?: string): void {
    if (!projectId) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${projectId}:`)) this.cache.delete(key);
    }
  }

  async getRuntime(
    scope: Readonly<SessionProjectScope>,
    sessionId: string,
  ): Promise<HookRuntime> {
    const configuration = await this.getConfiguration(scope);
    return new HookRuntime({
      configuration,
      trust: (request) => this.authorize(request, sessionId),
      onDiagnostic: (diagnostic) => this.logDiagnostic(diagnostic),
      onAsyncOutput: (event, output) =>
        this.options.log?.(
          `[hooks] async ${event} handler ${output.handlerKey} completed with exit ${output.exitCode ?? "signal"}`,
        ),
    });
  }

  private getConfiguration(scope: Readonly<SessionProjectScope>) {
    const cacheKey = `${scope.projectId}:${scope.workspaceFolderUri}`;
    let cached = this.cache.get(cacheKey);
    if (!cached) {
      cached = this.loadConfiguration(scope);
      this.cache.set(cacheKey, cached);
    }
    return cached;
  }

  private async loadConfiguration(scope: Readonly<SessionProjectScope>) {
    const definitions: HookSourceDefinition[] = [];
    const home = this.options.homeDirectory ?? os.homedir();
    const cwd = scope.rootPath;
    if (!cwd) return parseHookSources([]);

    for (const namespace of HOOK_NAMESPACES) {
      const filePath = path.join(home, namespace, "hooks.json");
      const content = await readHookFile(filePath, this.options.log);
      if (content !== undefined) {
        definitions.push({ id: filePath, content, cwd, kind: "configuration" });
      }
    }
    for (const namespace of HOOK_NAMESPACES) {
      const filePath = path.join(cwd, namespace, "hooks.json");
      const content = await readHookFile(filePath, this.options.log);
      if (content !== undefined) {
        definitions.push({ id: filePath, content, cwd, kind: "configuration" });
      }
    }

    if (this.options.pluginCatalog) {
      const snapshot = await this.options.pluginCatalog.getSnapshot(scope);
      for (const source of snapshot.hooks ?? []) {
        definitions.push({
          id: `plugin:${source.installInstanceId}:${source.sourceRelativePath}`,
          content: JSON.stringify({
            ...(source.description ? { description: source.description } : {}),
            hooks: source.hooks,
          }),
          kind: "plugin",
          reviewed: true,
          cwd,
          plugin: {
            root: source.pluginRoot,
            data: source.pluginData,
          },
        });
      }
    }

    return parseHookSources(definitions);
  }

  private authorize(
    request: Readonly<HookTrustRequest>,
    sessionId: string,
  ): Promise<boolean> | boolean {
    const state = this.options.configStore.getHookState(request.key);
    if (state?.enabled === false) return false;
    if (request.sourceKind === "plugin" && request.sourceReviewed) return true;
    if (state?.trustedHash === request.hash) return true;
    if (!this.options.onApprovalRequest) return false;

    const pendingKey = `${request.key}:${request.hash}`;
    let pending = this.pendingTrust.get(pendingKey);
    if (!pending) {
      pending = this.requestTrust(request, sessionId).finally(() =>
        this.pendingTrust.delete(pendingKey),
      );
      this.pendingTrust.set(pendingKey, pending);
    }
    return pending;
  }

  private async requestTrust(
    request: Readonly<HookTrustRequest>,
    sessionId: string,
  ): Promise<boolean> {
    const result = await this.options.onApprovalRequest!(
      {
        kind: "hook",
        title: `Run ${request.event} lifecycle hook?`,
        detail: [
          `Source: ${request.sourceId}`,
          `Definition hash: ${request.hash}`,
          "Lifecycle hooks execute local code outside AgentLink's command sandbox.",
          "Trusting this definition does not grant tool, write, network, or MCP approval.",
        ].join("\n\n"),
        commandText: request.command,
        commandReason: `${request.event} lifecycle hook`,
        humanOnlyReason:
          "Lifecycle hook definitions require explicit hash trust.",
        choices: [
          { label: "Run Once", value: "allow-once", isPrimary: true },
          { label: "Trust Definition", value: "trust-definition" },
          { label: "Disable Hook", value: "disable", isDanger: true },
        ],
      },
      sessionId,
    );
    const decision = typeof result === "string" ? result : result.decision;
    if (decision === "trust-definition") {
      return this.options.configStore.setHookTrustedHash(
        request.key,
        request.hash,
      );
    }
    if (decision === "disable") {
      this.options.configStore.setHookEnabled(request.key, false);
      return false;
    }
    return decision === "allow-once";
  }

  private logDiagnostic(diagnostic: HookDiagnostic): void {
    this.options.log?.(
      `[hooks] ${diagnostic.severity} ${diagnostic.code}${diagnostic.sourceId ? ` (${diagnostic.sourceId})` : ""}: ${diagnostic.message}`,
    );
  }
}

async function readHookFile(
  filePath: string,
  log?: (message: string) => void,
): Promise<string | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_HOOK_SOURCE_BYTES) {
      log?.(`[hooks] ignored oversized hook source ${filePath}`);
      return undefined;
    }
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log?.(`[hooks] failed to read ${filePath}: ${String(error)}`);
    }
    return undefined;
  }
}
