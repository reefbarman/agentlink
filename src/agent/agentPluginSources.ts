import * as fs from "node:fs/promises";
import * as path from "node:path";

import { fileURLToPath } from "node:url";

const ARCHIVE_SUFFIXES = [
  ".zip",
  ".tar",
  ".tar.gz",
  ".tgz",
  ".tar.bz2",
  ".tbz2",
  ".tar.xz",
  ".txz",
] as const;
const SCP_GIT_REMOTE = /^(?![A-Za-z]:[\\/])([^@\s/:]+@)?([^\s/:]+):([^\s]+)$/u;
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

export type AgentPluginSource =
  | {
      readonly kind: "local-directory";
      readonly path: string;
      readonly display: string;
      /** Present only after containment against an owning workspace folder. */
      readonly workspaceRelativePath?: string;
    }
  | {
      readonly kind: "local-archive";
      readonly path: string;
      readonly display: string;
    }
  | {
      readonly kind: "git";
      readonly remote: string;
      readonly display: string;
      readonly ref?: string;
      /** Exact reviewed commit used by project declarations. */
      readonly commit?: string;
    }
  | {
      readonly kind: "remote";
      readonly url: string;
      readonly display: string;
      readonly hint: "archive" | "git" | "unknown";
    };

export interface ParseAgentPluginSourceOptions {
  readonly cwd?: string;
  readonly ref?: string;
}

export class AgentPluginSourceError extends Error {
  constructor(
    readonly code:
      | "empty_source"
      | "invalid_source"
      | "unsupported_protocol"
      | "source_unavailable"
      | "unsupported_local_file"
      | "invalid_git_ref",
    message: string,
  ) {
    super(message);
    this.name = "AgentPluginSourceError";
  }
}

/**
 * Classifies user-provided plugin sources without imposing a Git-host allowlist.
 * Ambiguous HTTP(S) URLs remain `remote` so acquisition can inspect response
 * metadata/signatures and fall back to Git when appropriate.
 */
export async function parseAgentPluginSource(
  input: string,
  options: Readonly<ParseAgentPluginSourceOptions> = {},
): Promise<AgentPluginSource> {
  const source = stripMatchingQuotes(input.trim());
  if (!source) {
    throw new AgentPluginSourceError(
      "empty_source",
      "A plugin source is required.",
    );
  }
  if (hasControlCharacter(source)) {
    throw new AgentPluginSourceError(
      "invalid_source",
      "Plugin sources cannot contain control characters.",
    );
  }
  const ref = validateGitRef(options.ref);

  if (source.startsWith("git+")) {
    return parseExplicitGitSource(source.slice(4), ref);
  }
  if (source.startsWith("file:")) {
    let filePath: string;
    try {
      filePath = fileURLToPath(source);
    } catch {
      throw new AgentPluginSourceError(
        "invalid_source",
        `Invalid file URL: ${source}`,
      );
    }
    return classifyLocalPath(filePath);
  }

  const explicitUrl = parseUrl(source);
  if (explicitUrl) {
    if (explicitUrl.protocol === "https:" || explicitUrl.protocol === "http:") {
      if (explicitUrl.username || explicitUrl.password) {
        throw new AgentPluginSourceError(
          "invalid_source",
          "Plugin source URLs cannot embed credentials.",
        );
      }
      if (explicitUrl.hash) {
        throw new AgentPluginSourceError(
          "invalid_source",
          "URL fragments are not used to select plugin subdirectories; pass a Git ref separately.",
        );
      }
      const gitHint = looksLikeGitRemote(source);
      if (explicitUrl.protocol === "http:" && gitHint) {
        throw new AgentPluginSourceError(
          "unsupported_protocol",
          "Plugin Git remotes must use HTTPS or SSH; plaintext HTTP remains available only for archive downloads.",
        );
      }
      const url = explicitUrl.toString();
      return {
        kind: "remote",
        url,
        display: sanitizeRemoteDisplay(url),
        hint: looksLikeArchivePath(explicitUrl.pathname)
          ? "archive"
          : gitHint
            ? "git"
            : "unknown",
      };
    }
    if (explicitUrl.protocol === "ssh:") {
      if (explicitUrl.password) {
        throw new AgentPluginSourceError(
          "invalid_source",
          "Plugin Git URLs cannot embed passwords.",
        );
      }
      if (explicitUrl.hash) {
        throw new AgentPluginSourceError(
          "invalid_source",
          "Plugin Git URLs cannot contain fragments; pass a Git ref separately.",
        );
      }
      return {
        kind: "git",
        remote: source,
        display: sanitizeRemoteDisplay(source),
        ...(ref ? { ref } : {}),
      };
    }
    throw new AgentPluginSourceError(
      "unsupported_protocol",
      `Unsupported plugin source protocol '${explicitUrl.protocol}'. Use HTTP(S), SSH Git, a file URL, or a local path.`,
    );
  }

  if (SCP_GIT_REMOTE.test(source)) {
    if (source.startsWith("-") || source.includes("\\")) {
      throw new AgentPluginSourceError(
        "invalid_source",
        "Invalid SCP-style Git remote.",
      );
    }
    return {
      kind: "git",
      remote: source,
      display: sanitizeRemoteDisplay(source),
      ...(ref ? { ref } : {}),
    };
  }

  const localPath = path.resolve(options.cwd ?? process.cwd(), source);
  return classifyLocalPath(localPath);
}

export function sanitizeRemoteDisplay(remote: string): string {
  try {
    const parsed = new URL(remote);
    // SSH usernames such as `git@` select the transport account and must remain
    // in persisted provenance so updates use the same remote identity.
    if (parsed.protocol !== "ssh:") parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    // SCP-style Git remotes carry a transport username (commonly `git@`). It is
    // needed for reproducible updates and cannot encode a password.
    return remote;
  }
}

export function looksLikeArchivePath(value: string): boolean {
  const lower = value.toLowerCase();
  return ARCHIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function parsePluginCommandArgs(input: string): {
  readonly action: string;
  readonly operand: string;
  readonly ref?: string;
} {
  const trimmed = input.trim();
  if (!trimmed) return { action: "list", operand: "" };
  const separator = trimmed.search(/\s/u);
  const action = (
    separator < 0 ? trimmed : trimmed.slice(0, separator)
  ).toLowerCase();
  let operand = separator < 0 ? "" : trimmed.slice(separator).trim();
  let ref: string | undefined;
  const refMatch = operand.match(
    /(?:^|\s)--ref(?:=|\s+)("[^"]+"|'[^']+'|[^\s]+)/u,
  );
  if (refMatch?.index !== undefined) {
    ref = stripMatchingQuotes(refMatch[1]);
    operand =
      `${operand.slice(0, refMatch.index)} ${operand.slice(refMatch.index + refMatch[0].length)}`.trim();
  }
  return {
    action,
    operand: stripMatchingQuotes(operand),
    ...(ref ? { ref } : {}),
  };
}

async function classifyLocalPath(
  sourcePath: string,
): Promise<AgentPluginSource> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(sourcePath);
  } catch (error) {
    throw new AgentPluginSourceError(
      "source_unavailable",
      `Plugin source is unavailable: ${errorMessage(error)}`,
    );
  }
  if (stat.isDirectory()) {
    return {
      kind: "local-directory",
      path: sourcePath,
      display: path.basename(sourcePath) || sourcePath,
    };
  }
  if (!stat.isFile()) {
    throw new AgentPluginSourceError(
      "unsupported_local_file",
      "Plugin source must be a directory, plugin.json file, or supported archive.",
    );
  }
  if (path.basename(sourcePath) === "plugin.json") {
    const directory = path.dirname(sourcePath);
    return {
      kind: "local-directory",
      path: directory,
      display: path.basename(directory) || directory,
    };
  }
  if (!looksLikeArchivePath(sourcePath)) {
    throw new AgentPluginSourceError(
      "unsupported_local_file",
      "A local plugin file must be plugin.json or a ZIP/TAR archive.",
    );
  }
  return {
    kind: "local-archive",
    path: sourcePath,
    display: path.basename(sourcePath),
  };
}

function parseExplicitGitSource(
  source: string,
  ref?: string,
): AgentPluginSource {
  const parsed = parseUrl(source);
  const validUrl =
    parsed && (parsed.protocol === "https:" || parsed.protocol === "ssh:");
  if (!validUrl && (parsed !== undefined || !SCP_GIT_REMOTE.test(source))) {
    throw new AgentPluginSourceError(
      parsed?.protocol === "http:" ? "unsupported_protocol" : "invalid_source",
      parsed?.protocol === "http:"
        ? "Plugin Git remotes must use HTTPS or SSH; plaintext HTTP is not allowed."
        : "git+ sources must contain an HTTPS, SSH, or SCP-style Git remote.",
    );
  }
  if (parsed?.password || (parsed?.protocol === "https:" && parsed.username)) {
    throw new AgentPluginSourceError(
      "invalid_source",
      "Plugin Git URLs cannot embed HTTP credentials or SSH passwords.",
    );
  }
  if (parsed?.hash) {
    throw new AgentPluginSourceError(
      "invalid_source",
      "Plugin Git URLs cannot contain fragments; pass a Git ref separately.",
    );
  }
  return {
    kind: "git",
    remote: source,
    display: sanitizeRemoteDisplay(source),
    ...(ref ? { ref } : {}),
  };
}

function looksLikeGitRemote(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.endsWith(".git") || lower.startsWith("git+");
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function validateGitRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (
    value.length > 255 ||
    hasControlCharacter(value) ||
    /\s/u.test(value) ||
    value.startsWith("-") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith(".") ||
    value.endsWith("/")
  ) {
    throw new AgentPluginSourceError("invalid_git_ref", "Invalid Git ref.");
  }
  return value;
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  return (first === '"' || first === "'") && value.at(-1) === first
    ? value.slice(1, -1)
    : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
