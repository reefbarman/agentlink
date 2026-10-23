// Moved to @agentlink/sandbox; this path keeps existing imports working.
export type {
  SandboxBackendCapabilities,
  SandboxCapabilityRequest,
  SandboxEnvironmentBudgetMetadata,
  SandboxEnvironmentInheritance,
  SandboxEnvironmentPolicySummary,
  SandboxExecutionMetadata,
  SandboxViolation,
  SandboxViolationOperation,
} from "@agentlink/protocol/terminal-security";

export {
  CURRENT_SANDBOX_POLICY_VERSION,
  serializeSandboxLaunchBinding,
  validateCheckpointBSandboxCapabilityRequest,
  validateSandboxCapabilityGrant,
} from "@agentlink/sandbox";
export type {
  ApprovedSandboxCapabilityGrant,
  CheckpointBSandboxCapabilityValidationResult,
  SandboxCapabilityGrantInvalidReason,
  SandboxCapabilityGrantValidationRequest,
  SandboxCapabilityGrantValidationResult,
  SandboxEnvironmentPolicy,
  SandboxLaunchAuthorization,
  SandboxLaunchBindingInput,
  SandboxNetworkPolicy,
  SandboxPolicy,
  SandboxResourceLimits,
} from "@agentlink/sandbox";
