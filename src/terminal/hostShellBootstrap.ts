import { mkdir, rm, writeFile } from "node:fs/promises";

import type { HostShellLaunchDecision } from "./hostShellLaunchPolicy.js";
import type { ResolvedHostShellProfile } from "./shellProfileResolver.js";
import { createShellIntegrationScript } from "./shellIntegration.js";
import path from "node:path";

const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface HostShellBootstrapFile {
  relativePath: string;
  content: string;
}

export type HostShellBootstrapPlan =
  | {
      mode: "native-fallback";
      reason: string;
      message: string;
      profile: ResolvedHostShellProfile;
    }
  | {
      mode: "raw";
      profile: ResolvedHostShellProfile;
    }
  | {
      mode: "integrated";
      shell: "bash" | "zsh";
      nonce: string;
      artifactDirectory: string;
      files: readonly HostShellBootstrapFile[];
      profile: ResolvedHostShellProfile;
    };

export type MaterializedHostShellBootstrap =
  | Extract<HostShellBootstrapPlan, { mode: "native-fallback" | "raw" }>
  | (Extract<HostShellBootstrapPlan, { mode: "integrated" }> & {
      cleanup(): Promise<void>;
    });

export interface HostShellBootstrapInput {
  decision: HostShellLaunchDecision;
  runtimeRoot: string;
  artifactId: string;
  nonce: string;
  homeDirectory: string;
  originalZdotdir?: string;
}

export interface HostShellBootstrapFileOperations {
  mkdir(
    path: string,
    options: { recursive: boolean; mode: number },
  ): Promise<void>;
  writeFile(
    path: string,
    content: string,
    options: { encoding: "utf8"; flag: "wx"; mode: number },
  ): Promise<void>;
  rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
}

const defaultFileOperations: HostShellBootstrapFileOperations = {
  mkdir: async (directoryPath, options) => {
    await mkdir(directoryPath, options);
  },
  writeFile,
  rm,
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validateAbsoluteDirectory(value: string, name: string): void {
  if (!value || value.includes("\0") || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path without NUL`);
  }
}

function normalizeBashArgs(args: readonly string[]): string[] | undefined {
  if (args.length === 0) return ["--rcfile", "__AGENTLINK_RCFILE__", "-i"];
  if (args.length === 1 && args[0] === "-i") {
    return ["--rcfile", "__AGENTLINK_RCFILE__", "-i"];
  }
  return undefined;
}

function normalizeZshArgs(args: readonly string[]): string[] | undefined {
  let login = false;
  let interactive = false;
  for (const argument of args) {
    if (argument === "-l" || argument === "--login") {
      if (login) return undefined;
      login = true;
    } else if (argument === "-i") {
      if (interactive) return undefined;
      interactive = true;
    } else {
      return undefined;
    }
  }
  return [...(login ? ["-l"] : []), "-i"];
}

function sourceIfReadable(pathExpression: string): string[] {
  return [
    `if [[ -r ${pathExpression} ]]; then`,
    `  source ${pathExpression}`,
    "fi",
  ];
}

function bashPlan(
  input: HostShellBootstrapInput,
  artifactDirectory: string,
): HostShellBootstrapPlan {
  const normalizedArgs = normalizeBashArgs(input.decision.profile.shellArgs);
  if (!normalizedArgs) {
    return {
      mode: "native-fallback",
      reason: "unsupported-bash-arguments",
      message:
        "Bash shell integration supports only interactive non-login profiles without custom startup or command arguments.",
      profile: input.decision.profile,
    };
  }
  const rcPath = path.join(artifactDirectory, "bashrc");
  const userRc = path.join(input.homeDirectory, ".bashrc");
  const hook = createShellIntegrationScript("bash", input.nonce);
  return {
    mode: "integrated",
    shell: "bash",
    nonce: input.nonce,
    artifactDirectory,
    files: [
      {
        relativePath: "bashrc",
        content: [...sourceIfReadable(shellQuote(userRc)), hook, ""].join("\n"),
      },
    ],
    profile: {
      ...input.decision.profile,
      shellArgs: normalizedArgs.map((argument) =>
        argument === "__AGENTLINK_RCFILE__" ? rcPath : argument,
      ),
      environment: { ...input.decision.profile.environment },
    },
  };
}

function zshProxySource(fileName: string, afterSource: string[] = []): string {
  const userFile = `"$__agentlink_user_zdotdir/${fileName}"`;
  return [
    'export ZDOTDIR="$__agentlink_user_zdotdir"',
    ...sourceIfReadable(userFile),
    "__agentlink_user_zdotdir=${ZDOTDIR:-$__agentlink_user_zdotdir}",
    ...afterSource,
  ].join("\n");
}

function zshPlan(
  input: HostShellBootstrapInput,
  artifactDirectory: string,
): HostShellBootstrapPlan {
  const normalizedArgs = normalizeZshArgs(input.decision.profile.shellArgs);
  if (!normalizedArgs) {
    return {
      mode: "native-fallback",
      reason: "unsupported-zsh-arguments",
      message:
        "Zsh shell integration supports only interactive profiles with an optional login flag.",
      profile: input.decision.profile,
    };
  }
  const userZdotdir = input.originalZdotdir?.trim() || input.homeDirectory;
  validateAbsoluteDirectory(userZdotdir, "originalZdotdir");
  const hook = createShellIntegrationScript("zsh", input.nonce);
  const bootstrapAssignment = `export ZDOTDIR=${shellQuote(artifactDirectory)}`;
  const restoreForNestedShells = 'export ZDOTDIR="$__agentlink_user_zdotdir"';
  const zshenv = [
    `typeset -g __agentlink_bootstrap_zdotdir=${shellQuote(artifactDirectory)}`,
    `typeset -g __agentlink_user_zdotdir=${shellQuote(userZdotdir)}`,
    zshProxySource(".zshenv", [bootstrapAssignment]),
    "",
  ].join("\n");
  const zprofile = `${zshProxySource(".zprofile", [bootstrapAssignment])}\n`;
  const zshrc = [
    zshProxySource(".zshrc"),
    hook,
    "if [[ -o login ]]; then",
    `  ${bootstrapAssignment}`,
    "else",
    `  ${restoreForNestedShells}`,
    "fi",
    "",
  ].join("\n");
  const zlogin = `${zshProxySource(".zlogin", [restoreForNestedShells])}\n`;

  return {
    mode: "integrated",
    shell: "zsh",
    nonce: input.nonce,
    artifactDirectory,
    files: [
      { relativePath: ".zshenv", content: zshenv },
      { relativePath: ".zprofile", content: zprofile },
      { relativePath: ".zshrc", content: zshrc },
      { relativePath: ".zlogin", content: zlogin },
    ],
    profile: {
      ...input.decision.profile,
      shellArgs: normalizedArgs,
      environment: {
        ...input.decision.profile.environment,
        ZDOTDIR: artifactDirectory,
      },
    },
  };
}

export function planHostShellBootstrap(
  input: HostShellBootstrapInput,
): HostShellBootstrapPlan {
  validateAbsoluteDirectory(input.runtimeRoot, "runtimeRoot");
  validateAbsoluteDirectory(input.homeDirectory, "homeDirectory");
  if (!ARTIFACT_ID_PATTERN.test(input.artifactId)) {
    throw new Error(
      "artifactId must contain only URL-safe identifier characters",
    );
  }
  const artifactDirectory = path.join(input.runtimeRoot, input.artifactId);
  if (input.decision.mode === "native-fallback") {
    return {
      mode: "native-fallback",
      reason: input.decision.reason,
      message: input.decision.message,
      profile: input.decision.profile,
    };
  }
  if (input.decision.mode === "custom-raw") {
    return { mode: "raw", profile: input.decision.profile };
  }
  return input.decision.integrationKind === "bash"
    ? bashPlan(input, artifactDirectory)
    : zshPlan(input, artifactDirectory);
}

export async function materializeHostShellBootstrap(
  plan: HostShellBootstrapPlan,
  operations: HostShellBootstrapFileOperations = defaultFileOperations,
): Promise<MaterializedHostShellBootstrap> {
  if (plan.mode !== "integrated") return plan;
  let cleaned = false;
  let ownsArtifactDirectory = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned || !ownsArtifactDirectory) return;
    cleaned = true;
    await operations.rm(plan.artifactDirectory, {
      recursive: true,
      force: true,
    });
  };

  try {
    await operations.mkdir(plan.artifactDirectory, {
      recursive: false,
      mode: 0o700,
    });
    ownsArtifactDirectory = true;
    for (const file of plan.files) {
      if (
        !file.relativePath ||
        file.relativePath.includes("\0") ||
        path.isAbsolute(file.relativePath) ||
        file.relativePath.includes("/") ||
        file.relativePath.includes("\\")
      ) {
        throw new Error(
          "Bootstrap artifact names must be single relative files",
        );
      }
      await operations.writeFile(
        path.join(plan.artifactDirectory, file.relativePath),
        file.content,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    }
    return { ...plan, cleanup };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}
