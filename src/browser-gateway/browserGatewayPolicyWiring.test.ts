import { describe, expect, it, vi } from "vitest";

import type { SessionProjectScope } from "@agentlink/protocol/workspace-project";
import { wireBrowserGatewayApprovalPolicies } from "./browserGatewayPolicyWiring.js";

describe("wireBrowserGatewayApprovalPolicies", () => {
  it("forwards the complete addressed project scope to the policy consumer", () => {
    let configuredGetter:
      | ((projectScope?: SessionProjectScope) => "safe" | "sensitive")
      | undefined;
    const service = {
      setCommandApprovalPolicyGetters: vi.fn(
        (
          _effective: () => string,
          configured: (
            projectScope?: SessionProjectScope,
          ) => "safe" | "sensitive",
        ) => {
          configuredGetter = configured;
        },
      ),
    };
    const getConfiguredCommandApprovalPolicy = vi.fn(
      () => "sensitive" as const,
    );
    const provider = {
      getBrowserCommandApprovalPolicy: vi.fn(() => "safe" as const),
      getConfiguredCommandApprovalPolicy,
    };
    const distinctiveScope: SessionProjectScope = {
      schemaVersion: 1,
      kind: "project",
      projectId: "project-detached",
      workspaceFolderUri: "file:///workspace/detached",
      displayName: "Detached",
      rootPath: "/workspace/detached",
    };

    wireBrowserGatewayApprovalPolicies(service as never, provider as never);
    expect(configuredGetter?.(distinctiveScope)).toBe("sensitive");
    expect(getConfiguredCommandApprovalPolicy).toHaveBeenCalledWith(
      distinctiveScope,
    );
  });
});
