export type SandboxPreparationFailure =
  | "reserved_path_override"
  | "reserved_environment_override"
  | "conflicting_npm_cache_overrides"
  | "unsupported_shell_profile"
  | "preparation_failed";

export type SandboxPreparationPhase =
  | "workspace_roots"
  | "working_directory"
  | "private_directories"
  | "inline_files"
  | "git_protection"
  | "workspace_policy_integrity"
  | "developer_toolchain"
  | "trusted_runtime_roots"
  | "temporary_directory"
  | "environment"
  | "read_policy"
  | "launch_binding";

/** Only allowlisted categories and bounded environment key names, never values or paths. */
export interface SandboxPreparationDiagnostic {
  readonly phase?: SandboxPreparationPhase;
  readonly category?:
    | "not_found"
    | "permission_denied"
    | "invalid_path"
    | "io_failure"
    | "environment_budget_failed"
    | "validation_failed";
  readonly environment_keys?: readonly string[];
  readonly environment_key_count?: number;
}

export function sandboxEnvironmentKeyDiagnostic(names: readonly string[]) {
  const unique = [...new Set(names)].sort();
  return {
    environment_keys: Object.freeze(
      unique
        .filter((name) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))
        .slice(0, 16),
    ),
    environment_key_count: unique.length,
  };
}

export class SandboxPreparationError extends Error {
  readonly code = "sandbox_preparation_failed";
  readonly commandStarted = false;

  constructor(
    readonly reason: SandboxPreparationFailure,
    options?: ErrorOptions,
    readonly diagnostic?: SandboxPreparationDiagnostic,
  ) {
    super(`Sandbox execution could not be prepared: ${reason}`, options);
    this.name = "SandboxPreparationError";
  }
}

/** Preserve specialised policy errors. Wrap only generic preparation failures. */
export function sandboxPreparationFailure(
  error: unknown,
  phase: SandboxPreparationPhase,
): unknown {
  if (error instanceof Error && error.constructor !== Error) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const category =
    code === "ENOENT"
      ? "not_found"
      : code === "EACCES" || code === "EPERM"
        ? "permission_denied"
        : code === "ENOTDIR" || code === "ELOOP" || code === "EINVAL"
          ? "invalid_path"
          : code === "EIO" || code === "EMFILE" || code === "ENOSPC"
            ? "io_failure"
            : "validation_failed";
  return new SandboxPreparationError(
    "preparation_failed",
    { cause: error },
    { phase, category },
  );
}
