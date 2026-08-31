import type {
  AgentTerminalExecutionAuthority,
  ManagedNetworkDecision,
  ManagedNetworkRequest,
  SandboxBackendCapabilities,
  SandboxCapabilityRequest,
  SandboxEnvironmentBudgetMetadata,
  SandboxEnvironmentInheritance,
  SandboxEnvironmentPolicySummary,
  SandboxExecutionMetadata,
  SandboxViolation,
  TerminalExecutionApprovalRequirement,
  TerminalExecutionAuthorityReason,
  TerminalExecutionRouteContext,
  TerminalExecutionRouteReason,
  TerminalExecutionSecurityFailure,
  TerminalExecutionSecuritySummary,
  TerminalSandboxPermissionIntent,
} from "./terminalSecurity.js";
import { expect, expectTypeOf, it } from "vitest";

it("pins terminal execution authority and policy unions", () => {
  expectTypeOf<AgentTerminalExecutionAuthority>().toEqualTypeOf<
    "native-agent" | "sandbox"
  >();
  expectTypeOf<TerminalSandboxPermissionIntent>().toEqualTypeOf<
    "default" | "additional-permissions" | "native-escalation"
  >();
  expectTypeOf<TerminalExecutionApprovalRequirement>().toEqualTypeOf<
    "policy" | "explicit-permissions" | "explicit-escalation"
  >();
  expectTypeOf<TerminalExecutionAuthorityReason>().toEqualTypeOf<
    | "approval-policy"
    | "additional-permissions"
    | "explicit-escalation"
    | "explicit-rule"
  >();
  expectTypeOf<ManagedNetworkDecision>().toEqualTypeOf<
    "allow-once" | "reject"
  >();
  expectTypeOf<TerminalExecutionRouteReason>().toEqualTypeOf<
    | "verified-local-macos"
    | "feature-disabled"
    | "unsupported-host"
    | "remote-host"
    | "runtime-unavailable"
  >();
  expectTypeOf<TerminalExecutionSecurityFailure>().toEqualTypeOf<
    | "untrusted_workspace"
    | "policy_drift"
    | "host_target"
    | "wrong_authority"
    | "ambiguous_name"
    | "not_found"
    | "native_runtime_unavailable"
    | "required_sandbox_unavailable"
    | "attestation_failed"
    | "lease_revoked"
    | "stale_generation"
    | "attestation_changed"
    | "runtime_identity_changed"
    | "terminal_target_changed"
    | "provider_retired"
    | "launch_failed"
    | "cleanup_failed"
  >();
  expectTypeOf<TerminalExecutionRouteContext>().toEqualTypeOf<{
    readonly approvalPolicySnapshot: "on-request";
    readonly approvalReviewerSnapshot: "user" | "auto-review";
    readonly executionPresetSnapshot: "native-manual" | "workspace-write";
    readonly requiredAuthority: "native-agent" | "sandbox";
    readonly permissionIntent:
      | "default"
      | "additional-permissions"
      | "native-escalation";
    readonly approvalRequirement:
      | "policy"
      | "explicit-permissions"
      | "explicit-escalation";
    readonly authorityReason:
      | "approval-policy"
      | "additional-permissions"
      | "explicit-escalation"
      | "explicit-rule";
    readonly commandApprovalPolicySnapshot:
      | "manual"
      | "safe"
      | "sensitive"
      | "approve-for-me";
    readonly commandExecutionPolicySnapshot?: "read-only";
  }>();
});

it("pins the token-free sandbox metadata closure", () => {
  expectTypeOf<SandboxEnvironmentInheritance>().toEqualTypeOf<
    "all" | "core" | "none"
  >();
  expectTypeOf<SandboxEnvironmentPolicySummary>().toEqualTypeOf<{
    inherit: "all" | "core" | "none";
    ignoreDefaultExcludes: boolean;
    exclude: string[];
    setKeys: string[];
    includeOnly: string[];
    useProfile: boolean;
  }>();
  expectTypeOf<SandboxEnvironmentBudgetMetadata>().toEqualTypeOf<{
    limitBytes: number;
    estimatedBytes: number;
    protectedBytes: number;
    dropped: Array<{ name: string; bytes: number }>;
  }>();
  expectTypeOf<SandboxCapabilityRequest>().toEqualTypeOf<{
    readPaths?: string[];
    writePaths?: string[];
    networkDomains?: string[];
    unrestrictedPublicNetwork?: boolean;
    privateNetworkTargets?: string[];
    allowLocalBinding?: boolean;
  }>();
  expectTypeOf<SandboxBackendCapabilities["network"]>().toEqualTypeOf<
    | "blocked"
    | "loopback"
    | "loopback-listener"
    | "proxy-only"
    | "partial"
    | "unrestricted"
  >();
  expectTypeOf<SandboxViolation["operation"]>().toEqualTypeOf<
    | "file-read"
    | "file-write"
    | "network-connect"
    | "ipc-connect"
    | "process-control"
    | "resource-limit"
  >();
  expectTypeOf<SandboxExecutionMetadata>().toEqualTypeOf<{
    policyVersion: string;
    profileId: string;
    backend: string;
    backendVersion?: string;
    capabilities: SandboxBackendCapabilities;
    grantTiming?: "preparation" | "launch";
    grant?: { grantId: string; auditId: string };
    environmentPolicy?: SandboxEnvironmentPolicySummary;
    environmentBudget?: SandboxEnvironmentBudgetMetadata;
    capabilityRequest?: SandboxCapabilityRequest;
    violations?: SandboxViolation[];
  }>();
});

it("keeps terminal security evidence serializable across approval surfaces", () => {
  const security: TerminalExecutionSecuritySummary = {
    auditId: "audit-1",
    route: "sandbox",
    executionSurface: "verified-sandbox",
    confinement: "verified-baseline",
    routeReason: "verified-local-macos",
    approvalPolicySnapshot: "on-request",
    approvalReviewerSnapshot: "auto-review",
    executionPresetSnapshot: "workspace-write",
    requiredAuthority: "sandbox",
    permissionIntent: "additional-permissions",
    approvalRequirement: "explicit-permissions",
    authorityReason: "additional-permissions",
    commandApprovalPolicySnapshot: "approve-for-me",
    executionPolicy: "sandbox-baseline-v2",
    preparedAt: 1,
    sandbox: {
      attestationId: "attestation-1",
      attestationVersion: "v1",
      policyVersion: "policy-v1",
      profileId: "workspace-write",
      backend: "seatbelt",
      architecture: "arm64",
      capabilities: {
        backend: "seatbelt",
        processTree: true,
        filesystemRead: "host-visible",
        filesystemWrite: "strict",
        network: "partial",
        privateHome: false,
        privateTmp: false,
        hostIpcBlocked: false,
        resourceLimits: "partial",
        warnings: [],
      },
      capabilityRequest: { allowLocalBinding: true },
    },
  };
  const routeContext: TerminalExecutionRouteContext = security;

  expect(JSON.parse(JSON.stringify(security))).toEqual(security);
  expect(routeContext.requiredAuthority).toBe("sandbox");
});

it("pins managed-network destination evidence", () => {
  expectTypeOf<ManagedNetworkRequest>().toEqualTypeOf<{
    requestId: string;
    sessionId: string;
    auditId: string;
    terminalId: string;
    commandId: string;
    generation: number;
    command: string;
    cwd: string;
    reason?: string;
    host: string;
    protocol: "http" | "https" | "tcp";
    port: number;
    address: string;
    family: 4 | 6;
    dnsAnswers: Array<{ address: string; family: 4 | 6 }>;
    destinationClass: "public";
  }>();
});
