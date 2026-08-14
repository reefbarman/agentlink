export type SandboxCapabilityLaunchFailure =
  | "issue_failed"
  | "compile_failed"
  | "unknown_handle"
  | "unknown_grant"
  | "not_consumed"
  | "consumed"
  | "expired"
  | "revoked"
  | "wrong_session"
  | "wrong_binding"
  | "wrong_policy_version";

export class SandboxCapabilityLaunchError extends Error {
  readonly code = "sandbox_capability_launch_failed";
  readonly failureStage = "launch" as const;

  constructor(
    readonly reason: SandboxCapabilityLaunchFailure,
    options?: ErrorOptions,
  ) {
    super(
      `Sandbox capability grant could not be activated: ${reason}`,
      options,
    );
    this.name = "SandboxCapabilityLaunchError";
  }
}
