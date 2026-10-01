export type SandboxPreparationFailure =
  | "reserved_path_override"
  | "reserved_environment_override"
  | "unsupported_shell_profile"
  | "preparation_failed";

export class SandboxPreparationError extends Error {
  readonly code = "sandbox_preparation_failed";
  readonly commandStarted = false;

  constructor(
    readonly reason: SandboxPreparationFailure,
    options?: ErrorOptions,
  ) {
    super(`Sandbox execution could not be prepared: ${reason}`, options);
    this.name = "SandboxPreparationError";
  }
}
