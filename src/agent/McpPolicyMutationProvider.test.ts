import type {
  McpConfigBatchMutation,
  McpConfigMutationTarget,
} from "../shared/mcpManagerTypes.js";
import { describe, expect, it, vi } from "vitest";

import { AgentPluginStoreError } from "./AgentPluginStore.js";
import { DefaultMcpPolicyMutationProvider } from "./McpPolicyMutationProvider.js";
import type { McpConfigProvenance } from "./mcpConfig.js";
import type { SessionProjectScope } from "../core/workspaceProjects.js";

const scope: SessionProjectScope = {
  schemaVersion: 1,
  kind: "project",
  projectId: "project-a",
  workspaceFolderUri: "file:///workspace-a",
  displayName: "Project A",
  rootPath: "/workspace-a",
};

const provenance: Extract<McpConfigProvenance, { kind: "agent-plugin" }> = {
  kind: "agent-plugin",
  scope: { kind: "global" },
  installInstanceId: "install-a",
  packageDigest: "a".repeat(64),
  portableServerName: "tools",
  runtimeServerName: "plugin-install-a-tools",
};

const target: Extract<
  McpConfigMutationTarget,
  { kind: "agent-plugin-overlay" }
> = {
  kind: "agent-plugin-overlay",
  installInstanceId: "install-a",
  packageDigest: "a".repeat(64),
  declaredServerName: "tools",
  runtimeServerName: "plugin-install-a-tools",
  scope: "global",
  projectId: "project-a",
};

function mutation(
  operation: McpConfigBatchMutation["operations"][number] = {
    kind: "upsert",
    conflictAction: "replace",
    server: {
      name: target.runtimeServerName,
      disabled: false,
      toolPolicy: "ask",
      allowedTools: ["read"],
      toolDisclosure: "deferred",
      supportsParallelToolCalls: true,
    },
  },
): McpConfigBatchMutation {
  return {
    operationId: "operation-a",
    profile: "main",
    scope: "global",
    target,
    expectedRevision: "plugin-registry:7",
    operations: [operation],
  };
}

describe("DefaultMcpPolicyMutationProvider", () => {
  it("routes plugin tool/server approvals and disablement to registry overlays", async () => {
    const mutateMcpPolicy = vi
      .fn()
      .mockImplementation(
        async ({ update }: { update: (value: {}) => unknown }) => ({
          policy: { mcp: { tools: update({ allowedTools: ["existing"] }) } },
        }),
      );
    const provider = new DefaultMcpPolicyMutationProvider({
      agentPluginManagerHost: { mutateMcpPolicy } as never,
    });

    await provider.persistToolApproval({
      provenance,
      bareToolName: "read",
      scope: "global",
      requestingScope: scope,
    });
    await provider.persistServerApproval({
      provenance,
      scope: "global",
      requestingScope: scope,
    });
    await provider.setServerDisabled({
      provenance,
      disabled: true,
      requestingScope: scope,
    });

    expect(mutateMcpPolicy).toHaveBeenCalledTimes(3);
    expect(
      mutateMcpPolicy.mock.calls.map(([request]) => request.target),
    ).toEqual([target, target, target]);
    expect(
      mutateMcpPolicy.mock.calls[0]![0].update({ allowedTools: ["existing"] }),
    ).toEqual({
      allowedTools: ["existing", "read"],
    });
    expect(mutateMcpPolicy.mock.calls[1]![0].update({})).toEqual({
      toolPolicy: "allow",
    });
    expect(mutateMcpPolicy.mock.calls[2]![0].update({})).toEqual({
      disabled: true,
    });
  });

  it("rejects approval promotion across plugin ownership scopes", async () => {
    const provider = new DefaultMcpPolicyMutationProvider({
      agentPluginManagerHost: { mutateMcpPolicy: vi.fn() } as never,
    });

    await expect(
      provider.persistToolApproval({
        provenance,
        bareToolName: "read",
        scope: "project",
        requestingScope: scope,
      }),
    ).rejects.toThrow("cannot be saved to project scope");
  });

  it("routes policy-only manager updates with optimistic registry revisions", async () => {
    const mutateMcpPolicy = vi.fn(async ({ update }) => ({
      policy: { mcp: { tools: update({ allowedTools: ["old"] }) } },
    }));
    const provider = new DefaultMcpPolicyMutationProvider({
      agentPluginManagerHost: { mutateMcpPolicy } as never,
    });

    const result = await provider.mutateManagerPolicy(mutation(), scope);

    expect(result).toMatchObject({
      ok: true,
      configSaved: true,
      connectionOutcomes: [{ serverName: "tools", status: "not_connected" }],
    });
    expect(mutateMcpPolicy).toHaveBeenCalledWith({
      target,
      expectedRevision: 7,
      update: expect.any(Function),
    });
    expect(
      mutateMcpPolicy.mock.calls[0]![0].update({ allowedTools: ["old"] }),
    ).toEqual({
      disabled: false,
      toolPolicy: "ask",
      allowedTools: ["read"],
      toolDisclosure: "deferred",
      supportsParallelToolCalls: true,
    });
  });

  it.each([
    ["remove", { kind: "remove", serverName: target.runtimeServerName }],
    [
      "rename",
      {
        kind: "upsert",
        conflictAction: "replace",
        renameTo: "other",
        server: { name: target.runtimeServerName },
      },
    ],
    [
      "command",
      {
        kind: "upsert",
        conflictAction: "replace",
        server: { name: target.runtimeServerName, command: "other" },
      },
    ],
  ] as const)(
    "rejects immutable plugin manager %s mutations",
    async (_name, operation) => {
      const mutateMcpPolicy = vi.fn();
      const provider = new DefaultMcpPolicyMutationProvider({
        agentPluginManagerHost: { mutateMcpPolicy } as never,
      });

      const result = await provider.mutateManagerPolicy(
        mutation(operation as McpConfigBatchMutation["operations"][number]),
        scope,
      );

      expect(result).toMatchObject({
        ok: false,
        errors: [{ code: "scope_not_writable" }],
      });
      expect(mutateMcpPolicy).not.toHaveBeenCalled();
    },
  );

  it("surfaces stale plugin registry revisions as config conflicts", async () => {
    const mutateMcpPolicy = vi.fn(async () => {
      throw new AgentPluginStoreError(
        "registry_revision_conflict",
        "registry changed",
      );
    });
    const provider = new DefaultMcpPolicyMutationProvider({
      agentPluginManagerHost: { mutateMcpPolicy } as never,
    });

    await expect(
      provider.mutateManagerPolicy(mutation(), scope),
    ).resolves.toMatchObject({
      ok: false,
      configSaved: false,
      errors: [{ code: "config_changed", message: "registry changed" }],
    });
  });
});
