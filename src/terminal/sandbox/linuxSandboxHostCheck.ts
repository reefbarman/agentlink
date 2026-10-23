import {
  checkLinuxSandboxPrerequisites,
  type CheckLinuxSandboxPrerequisitesOptions,
  type LinuxSandboxPrerequisites,
} from "@agentlink/sandbox";

export type LinuxSandboxHostStatus =
  | { readonly available: true; readonly ripgrepPath: string | undefined }
  | { readonly available: false; readonly detail: string };

export interface LinuxSandboxHostCheckOptions {
  /** Whether this install staged node-pty for Linux; sandbox PTYs need it. */
  readonly nodePtyAvailable: boolean;
  /** Staged `dist/sandbox-runtime` directory. */
  readonly runtimeRoot: string;
  /** VS Code's ripgrep, when it can be found. May be a bare `rg`. */
  readonly resolveRipgrep: () => Promise<string | undefined>;
  readonly log: (message: string) => void;
  readonly checkPrerequisites?: (
    options: CheckLinuxSandboxPrerequisitesOptions,
  ) => Promise<LinuxSandboxPrerequisites>;
}

/**
 * Decides once whether this Linux host can run the bubblewrap sandbox. The
 * result is cached for the window: installing a missing tool or changing the
 * host's user-namespace policy takes effect after a reload. Every failure
 * returns unavailable, so commands never reach a sandbox route the doctor
 * has not passed.
 */
export function createLinuxSandboxHostCheck(
  options: LinuxSandboxHostCheckOptions,
): () => Promise<LinuxSandboxHostStatus> {
  const checkPrerequisites =
    options.checkPrerequisites ?? checkLinuxSandboxPrerequisites;
  let pending: Promise<LinuxSandboxHostStatus> | undefined;
  const run = async (): Promise<LinuxSandboxHostStatus> => {
    if (!options.nodePtyAvailable) {
      const detail =
        "This install has no node-pty build for this Linux host, which the sandbox terminal needs.";
      options.log(`[sandbox-terminal] Linux sandbox unavailable: ${detail}`);
      return { available: false, detail };
    }
    const hostRipgrep = await options.resolveRipgrep().catch(() => undefined);
    let result: LinuxSandboxPrerequisites;
    try {
      result = await checkPrerequisites({
        runtimeRoot: options.runtimeRoot,
        ...(hostRipgrep ? { ripgrepPath: hostRipgrep } : {}),
      });
    } catch (error) {
      const detail = `The Linux sandbox check failed: ${error instanceof Error ? error.message : String(error)}`;
      options.log(`[sandbox-terminal] ${detail}`);
      return { available: false, detail };
    }
    for (const check of result.checks) {
      options.log(
        `[sandbox-terminal] Linux sandbox check ${check.id}: ${check.status}, ${check.detail}${check.fix ? ` Fix: ${check.fix}` : ""}`,
      );
    }
    if (!result.available) {
      options.log(
        "[sandbox-terminal] Linux sandbox prerequisites are missing; agent commands use the VS Code terminal until they are fixed and the window is reloaded.",
      );
      const failing = result.checks
        .filter((check) => check.status !== "pass")
        .map((check) => check.detail)
        .join(" ");
      return {
        available: false,
        detail: failing || "Linux sandbox prerequisites are missing.",
      };
    }
    // The doctor and the helper both fall back to /usr/bin/rg when the
    // host's ripgrep is unusable; pass the host's only when it was chosen.
    const ripgrep = result.checks.find((check) => check.id === "ripgrep");
    return {
      available: true,
      ripgrepPath:
        hostRipgrep && ripgrep?.detail === hostRipgrep
          ? hostRipgrep
          : undefined,
    };
  };
  return () => {
    pending ??= run();
    return pending;
  };
}
