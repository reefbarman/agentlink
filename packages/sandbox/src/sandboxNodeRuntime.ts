import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

const NODE_PTY_RELATIVE_PATH = path.join(
  "dist",
  "sandbox-runtime",
  "node_modules",
  "node-pty",
);
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const STANDARD_NODE_PATHS = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
] as const;

export interface SandboxNodeRuntimeProbeResult {
  ok: boolean;
  detail?: string;
}

export interface SandboxNodeRuntimeFileOperations {
  access(filePath: string, mode: number): Promise<void>;
  realpath(filePath: string): Promise<string>;
  stat(filePath: string): Promise<Stats>;
}

export interface ResolveSandboxNodeRuntimeOptions {
  extensionRoot: string;
  configuredPath?: string;
  environmentPath?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  userId?: number;
  fileOperations?: SandboxNodeRuntimeFileOperations;
  probe?: (
    executable: string,
    nodePtyRoot: string,
    architecture: string,
  ) => Promise<SandboxNodeRuntimeProbeResult>;
}

export interface ResolvedSandboxNodeRuntime {
  executable: string;
  source: "configured" | "environment" | "standard";
}

export class SandboxNodeRuntimeUnavailableError extends Error {
  constructor(
    message: string,
    readonly attempts: readonly string[],
  ) {
    super(message);
    this.name = "SandboxNodeRuntimeUnavailableError";
  }
}

const defaultFileOperations: SandboxNodeRuntimeFileOperations = {
  access,
  realpath,
  stat,
};

function candidatePaths(
  configuredPath: string | undefined,
  environmentPath: string | undefined,
): Array<{ path: string; source: ResolvedSandboxNodeRuntime["source"] }> {
  const configured = configuredPath?.trim();
  if (configured) return [{ path: configured, source: "configured" }];

  const candidates: Array<{
    path: string;
    source: ResolvedSandboxNodeRuntime["source"];
  }> = [];
  for (const directory of environmentPath?.split(path.delimiter) ?? []) {
    if (!directory || !path.isAbsolute(directory)) continue;
    candidates.push({
      path: path.join(directory, "node"),
      source: "environment",
    });
  }
  for (const candidate of STANDARD_NODE_PATHS) {
    candidates.push({ path: candidate, source: "standard" });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const normalized = path.normalize(candidate.path);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function describeProbeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const result = error as Error & { stderr?: string; stdout?: string };
  return result.stderr?.trim() || result.stdout?.trim() || result.message;
}

async function defaultProbe(
  executable: string,
  nodePtyRoot: string,
  architecture: string,
): Promise<SandboxNodeRuntimeProbeResult> {
  const script = String.raw`
const nodePtyRoot = process.argv[1];
const expectedArchitecture = process.argv[2];
if (process.versions.electron) throw new Error("Electron is not a standalone Node runtime");
if (process.platform !== "darwin") throw new Error("expected a macOS Node runtime");
if (process.arch !== expectedArchitecture) {
  throw new Error("expected architecture " + expectedArchitecture + ", received " + process.arch);
}
const nodePty = require(nodePtyRoot);
const terminal = nodePty.spawn("/usr/bin/true", [], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: "/tmp",
  env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" },
});
const timer = setTimeout(() => {
  terminal.kill();
  throw new Error("node-pty probe timed out");
}, 3000);
terminal.onExit(({ exitCode, signal }) => {
  clearTimeout(timer);
  if (exitCode !== 0) {
    throw new Error("node-pty probe exited with code=" + exitCode + " signal=" + signal);
  }
  process.stdout.write(JSON.stringify({ marker: "agentlink-sandbox-node", arch: process.arch }));
});
`;

  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        executable,
        ["-e", script, nodePtyRoot, architecture],
        {
          timeout: DEFAULT_PROBE_TIMEOUT_MS,
          maxBuffer: MAX_PROBE_OUTPUT_BYTES,
          env: {
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            LANG: "en_US.UTF-8",
            LC_ALL: "en_US.UTF-8",
          },
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(Object.assign(error, { stdout, stderr }));
            return;
          }
          resolve(stdout);
        },
      );
    });
    const result = JSON.parse(output) as { marker?: string; arch?: string };
    return {
      ok:
        result.marker === "agentlink-sandbox-node" &&
        result.arch === architecture,
      ...(!(
        result.marker === "agentlink-sandbox-node" &&
        result.arch === architecture
      )
        ? { detail: "runtime probe returned an unexpected result" }
        : {}),
    };
  } catch (error) {
    return { ok: false, detail: describeProbeFailure(error) };
  }
}

async function validateCandidate(
  candidate: string,
  operations: SandboxNodeRuntimeFileOperations,
  userId: number | undefined,
): Promise<string> {
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) {
    throw new Error("path must be absolute and contain no NUL");
  }
  const canonical = await operations.realpath(candidate);
  const metadata = await operations.stat(canonical);
  if (!metadata.isFile()) throw new Error("path is not a regular file");
  if ((metadata.mode & 0o111) === 0) throw new Error("file is not executable");
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error("file is group- or world-writable");
  }
  if (userId !== undefined && metadata.uid !== 0 && metadata.uid !== userId) {
    throw new Error("file is not owned by the current user or root");
  }
  await operations.access(canonical, constants.X_OK);
  return canonical;
}

export async function resolveSandboxNodeRuntime(
  options: ResolveSandboxNodeRuntimeOptions,
): Promise<ResolvedSandboxNodeRuntime> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  if (platform !== "darwin") {
    throw new SandboxNodeRuntimeUnavailableError(
      "AgentLink Terminal currently supports local macOS only.",
      [],
    );
  }
  if (architecture !== "arm64" && architecture !== "x64") {
    throw new SandboxNodeRuntimeUnavailableError(
      `AgentLink Terminal does not support architecture ${architecture}.`,
      [],
    );
  }

  const operations = options.fileOperations ?? defaultFileOperations;
  const probe = options.probe ?? defaultProbe;
  const nodePtyRoot = path.join(
    path.resolve(options.extensionRoot),
    NODE_PTY_RELATIVE_PATH,
  );
  const attempts: string[] = [];
  const candidates = candidatePaths(
    options.configuredPath,
    options.environmentPath ?? process.env.PATH,
  );

  for (const candidate of candidates) {
    let canonical: string;
    try {
      canonical = await validateCandidate(
        candidate.path,
        operations,
        options.userId ?? process.getuid?.(),
      );
    } catch (error) {
      attempts.push(`${candidate.path}: ${describeProbeFailure(error)}`);
      continue;
    }

    const result = await probe(canonical, nodePtyRoot, architecture);
    if (result.ok) return { executable: canonical, source: candidate.source };
    attempts.push(
      `${canonical}: ${result.detail ?? "compatibility probe failed"}`,
    );
  }

  const configured = options.configuredPath?.trim();
  throw new SandboxNodeRuntimeUnavailableError(
    configured
      ? `The configured AgentLink Terminal Node runtime is unavailable or incompatible: ${configured}`
      : "AgentLink Terminal requires a compatible standalone Node.js runtime. No compatible runtime was found in VS Code's environment or standard macOS locations.",
    attempts,
  );
}
