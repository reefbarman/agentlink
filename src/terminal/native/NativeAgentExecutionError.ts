/** Safe pre-dispatch diagnostics. Never retain environment values in an error. */
export class NativeCommandEnvironmentError extends Error {
  readonly code = "native_command_environment_mismatch";
  readonly environmentKeys: readonly string[];
  readonly environmentKeyCount: number;

  constructor(
    readonly terminalId: string,
    keys: readonly string[],
  ) {
    super(
      "The selected Native Agent terminal has an incompatible command environment. No command was sent.",
    );
    this.name = "NativeCommandEnvironmentError";
    const unique = [...new Set(keys)].sort();
    this.environmentKeys = Object.freeze(
      unique
        .filter((key) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key))
        .slice(0, 16),
    );
    this.environmentKeyCount = unique.length;
  }
}

export interface NativeShellStartupDiagnostic {
  readonly shell: "bash" | "zsh";
  readonly profile_source: "configured" | "fallback";
  readonly login: boolean;
  readonly interactive: boolean;
  readonly phase:
    | "awaiting_initial_prompt"
    | "rendering_initial_prompt"
    | "awaiting_prompt_idle";
  readonly output: "none" | "present";
  readonly suspected_prompt:
    | "update"
    | "confirmation"
    | "credential"
    | "none_detected";
}

export class NativeShellStartupTimeoutError extends Error {
  readonly code = "native_shell_startup_timeout";

  constructor(
    seconds: number,
    readonly diagnostic: NativeShellStartupDiagnostic,
  ) {
    super(
      `Native Agent shell integration startup timed out after ${seconds}s. Shell: ${diagnostic.shell}; profile source: ${diagnostic.profile_source}; phase: ${diagnostic.phase}; startup output: ${diagnostic.output}; suspected prompt: ${diagnostic.suspected_prompt}. Raw shell output and profile paths are omitted.`,
    );
    this.name = "NativeShellStartupTimeoutError";
  }
}
