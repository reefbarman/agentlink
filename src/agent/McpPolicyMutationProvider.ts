import * as os from "node:os";
import * as path from "node:path";

import type { SessionProjectScope } from "@agentlink/protocol/workspace-project";
import type {
  McpConfigBatchMutation,
  McpConfigMutationResult,
  McpConfigMutationTarget,
} from "@agentlink/protocol/mcp-manager";
import {
  AgentPluginManagerError,
  AgentPluginManagerHost,
} from "./AgentPluginManagerHost.js";
import { AgentPluginStoreError } from "./AgentPluginStore.js";
import {
  getMcpConfigFilePaths,
  mutateMcpConfigBatch,
  persistMcpServerApproval,
  persistMcpToolApproval,
  type McpConfigProvenance,
} from "./mcpConfig.js";

export interface McpToolApprovalMutation {
  readonly provenance: McpConfigProvenance;
  readonly bareToolName: string;
  readonly scope: "project" | "global";
  readonly requestingScope: Readonly<SessionProjectScope>;
}

export interface McpServerApprovalMutation {
  readonly provenance: McpConfigProvenance;
  readonly scope: "project" | "global";
  readonly requestingScope: Readonly<SessionProjectScope>;
}

export interface McpServerPolicyMutation {
  readonly provenance: McpConfigProvenance;
  readonly disabled: boolean;
  readonly requestingScope: Readonly<SessionProjectScope>;
}

export interface McpPolicyMutationProvider {
  persistToolApproval(request: McpToolApprovalMutation): Promise<void>;
  persistServerApproval(request: McpServerApprovalMutation): Promise<void>;
  setServerDisabled(request: McpServerPolicyMutation): Promise<void>;
  mutateManagerPolicy(
    mutation: McpConfigBatchMutation,
    requestingScope: Readonly<SessionProjectScope>,
  ): Promise<McpConfigMutationResult>;
}

export interface DefaultMcpPolicyMutationProviderOptions {
  readonly agentPluginManagerHost?: AgentPluginManagerHost;
}

/** Routes native policy to MCP JSON and immutable plugin policy to registry overlays. */
export class DefaultMcpPolicyMutationProvider implements McpPolicyMutationProvider {
  constructor(
    private readonly options: Readonly<DefaultMcpPolicyMutationProviderOptions> = {},
  ) {}

  async persistToolApproval(request: McpToolApprovalMutation): Promise<void> {
    if (request.provenance.kind === "agent-plugin") {
      const target = pluginMutationTarget(
        request.provenance,
        request.requestingScope,
      );
      assertPluginApprovalScope(request.provenance, request.scope);
      await this.requirePluginManager().mutateMcpPolicy({
        target,
        update: (policy) => ({
          ...policy,
          allowedTools: [
            ...new Set([...(policy.allowedTools ?? []), request.bareToolName]),
          ],
        }),
      });
      return;
    }
    await persistMcpToolApproval(
      request.provenance.sourceServerName,
      request.bareToolName,
      nativePolicyPath(request.scope, request.requestingScope),
    );
  }

  async persistServerApproval(
    request: McpServerApprovalMutation,
  ): Promise<void> {
    if (request.provenance.kind === "agent-plugin") {
      const target = pluginMutationTarget(
        request.provenance,
        request.requestingScope,
      );
      assertPluginApprovalScope(request.provenance, request.scope);
      await this.requirePluginManager().mutateMcpPolicy({
        target,
        update: (policy) => ({ ...policy, toolPolicy: "allow" }),
      });
      return;
    }
    await persistMcpServerApproval(
      request.provenance.sourceServerName,
      nativePolicyPath(request.scope, request.requestingScope),
    );
  }

  async setServerDisabled(request: McpServerPolicyMutation): Promise<void> {
    if (request.provenance.kind !== "agent-plugin") {
      throw new Error(
        "Native disablement must use the native MCP batch writer.",
      );
    }
    await this.requirePluginManager().mutateMcpPolicy({
      target: pluginMutationTarget(request.provenance, request.requestingScope),
      update: (policy) => ({ ...policy, disabled: request.disabled }),
    });
  }

  async mutateManagerPolicy(
    mutation: McpConfigBatchMutation,
    requestingScope: Readonly<SessionProjectScope>,
  ): Promise<McpConfigMutationResult> {
    const target = mutation.target;
    if (!target || target.kind === "native") {
      return mutateMcpConfigBatch(mutation, requestingScope.rootPath);
    }
    if (mutation.operations.length !== 1) {
      return mutationFailure(
        mutation.operationId,
        "invalid_request",
        "Plugin MCP policy mutations must contain exactly one operation.",
      );
    }
    const operation = mutation.operations[0]!;
    if (
      operation.kind !== "upsert" ||
      operation.conflictAction !== "replace" ||
      operation.renameTo !== undefined ||
      operation.server.name !== target.runtimeServerName ||
      operation.server.type !== undefined ||
      operation.server.command !== undefined ||
      operation.server.args !== undefined ||
      operation.server.url !== undefined ||
      operation.server.timeout !== undefined ||
      operation.server.env !== undefined ||
      operation.server.headers !== undefined
    ) {
      return mutationFailure(
        mutation.operationId,
        "scope_not_writable",
        "Plugin connection fields and server identity are immutable.",
      );
    }
    try {
      const row = await this.requirePluginManager().mutateMcpPolicy({
        target,
        expectedRevision: requirePluginRevision(mutation.expectedRevision),
        update: () => ({
          disabled: operation.server.disabled,
          toolPolicy: operation.server.toolPolicy,
          allowedTools: operation.server.allowedTools,
          toolDisclosure: operation.server.toolDisclosure,
          supportsParallelToolCalls: operation.server.supportsParallelToolCalls,
        }),
      });
      return {
        operationId: mutation.operationId,
        ok: true,
        configSaved: true,
        errors: [],
        connectionOutcomes: [
          {
            serverName: target.declaredServerName,
            status: row.policy.mcp?.[target.declaredServerName]?.disabled
              ? "disabled"
              : "not_connected",
          },
        ],
      };
    } catch (error) {
      return mutationFailure(
        mutation.operationId,
        error instanceof AgentPluginStoreError &&
          error.code === "registry_revision_conflict"
          ? "config_changed"
          : error instanceof AgentPluginManagerError &&
              (error.code === "mcp_scope_mismatch" ||
                error.code === "mcp_package_changed" ||
                error.code === "mcp_server_not_found")
            ? "scope_not_writable"
            : "write_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private requirePluginManager(): AgentPluginManagerHost {
    if (!this.options.agentPluginManagerHost) {
      throw new Error("Agent Plugin policy mutation is unavailable.");
    }
    return this.options.agentPluginManagerHost;
  }
}

export function mcpMutationTarget(
  provenance: McpConfigProvenance,
  requestingScope: Readonly<SessionProjectScope> | undefined,
):
  | Extract<McpConfigMutationTarget, { kind: "agent-plugin-overlay" }>
  | undefined {
  if (provenance.kind !== "agent-plugin" || !requestingScope) return undefined;
  return pluginMutationTarget(provenance, requestingScope);
}

function pluginMutationTarget(
  provenance: Extract<McpConfigProvenance, { kind: "agent-plugin" }>,
  requestingScope: Readonly<SessionProjectScope>,
): Extract<McpConfigMutationTarget, { kind: "agent-plugin-overlay" }> {
  return {
    kind: "agent-plugin-overlay",
    installInstanceId: provenance.installInstanceId,
    packageDigest: provenance.packageDigest,
    declaredServerName: provenance.portableServerName,
    runtimeServerName: provenance.runtimeServerName,
    scope: provenance.scope.kind,
    projectId: requestingScope.projectId,
  };
}

function nativePolicyPath(
  scope: "project" | "global",
  requestingScope: Readonly<SessionProjectScope>,
): string {
  if (scope === "global")
    return path.join(os.homedir(), ".agentlink", "mcp.json");
  if (!requestingScope.rootPath) {
    throw new Error("Project MCP approval requires an available project root.");
  }
  return getMcpConfigFilePaths(requestingScope.rootPath).project;
}

function requirePluginRevision(value: string): number {
  if (value.startsWith("plugin-registry:")) {
    const parsed = Number(value.slice("plugin-registry:".length));
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  throw new AgentPluginStoreError(
    "registry_revision_conflict",
    "The plugin registry revision is missing or invalid.",
  );
}

function assertPluginApprovalScope(
  provenance: Extract<McpConfigProvenance, { kind: "agent-plugin" }>,
  requestedScope: "project" | "global",
): void {
  if (requestedScope !== provenance.scope.kind) {
    throw new Error(
      `This plugin policy is owned by ${provenance.scope.kind} scope and cannot be saved to ${requestedScope} scope.`,
    );
  }
}

function mutationFailure(
  operationId: string,
  code: McpConfigMutationResult["errors"][number]["code"],
  message: string,
): McpConfigMutationResult {
  return {
    operationId,
    ok: false,
    configSaved: false,
    errors: [{ code, message }],
  };
}
