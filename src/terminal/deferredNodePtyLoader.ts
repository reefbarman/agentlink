import type { HostShellBootstrapPlan } from "./hostShellBootstrap.js";
import type { NodePtyModule } from "./nodePtyFactory.js";
import { existsSync, lstatSync, readFileSync, type Stats } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const STAGED_NODE_PTY_RELATIVE_PATH = path.join(
  "dist",
  "sandbox-runtime",
  "node_modules",
  "node-pty",
);
const EXPECTED_NODE_PTY_VERSION = "1.1.0";

export interface CommonJsRequire {
  (specifier: string): unknown;
}

export interface NodePtyModuleLoader {
  load(): NodePtyModule;
}

export interface NodePtyLoaderFileOperations {
  exists(path: string): boolean;
  lstat(path: string): Stats;
  readFile(path: string): string;
}

export interface DeferredNodePtyLoaderOptions {
  extensionRoot: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  createRequire?: (filename: string) => CommonJsRequire;
  fileOperations?: NodePtyLoaderFileOperations;
}

const defaultFileOperations: NodePtyLoaderFileOperations = {
  exists: existsSync,
  lstat: lstatSync,
  readFile: (filePath) => readFileSync(filePath, "utf8"),
};

function assertExtensionRoot(extensionRoot: string): string {
  if (
    !extensionRoot ||
    extensionRoot.includes("\0") ||
    !path.isAbsolute(extensionRoot)
  ) {
    throw new Error("extensionRoot must be an absolute path without NUL");
  }
  return path.resolve(extensionRoot);
}

function isNodePtyModule(value: unknown): value is NodePtyModule {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { spawn?: unknown }).spawn === "function"
  );
}

function assertOwnedEntry(
  operations: NodePtyLoaderFileOperations,
  entryPath: string,
  kind: "file" | "directory",
): void {
  let metadata: Stats;
  try {
    metadata = operations.lstat(entryPath);
  } catch {
    throw new Error(`Packaged node-pty ${kind} is missing: ${entryPath}`);
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(
      `Packaged node-pty entry must not be a symlink: ${entryPath}`,
    );
  }
  if (
    (kind === "file" && !metadata.isFile()) ||
    (kind === "directory" && !metadata.isDirectory())
  ) {
    throw new Error(`Packaged node-pty entry is not a ${kind}: ${entryPath}`);
  }
}

function validateStagedPackage(options: {
  packageRoot: string;
  platform: NodeJS.Platform;
  architecture: string;
  operations: NodePtyLoaderFileOperations;
}): string {
  if (options.platform !== "darwin") {
    throw new Error("The packaged node-pty loader is supported only on Darwin");
  }
  if (options.architecture !== "arm64" && options.architecture !== "x64") {
    throw new Error(
      `The packaged node-pty loader does not support architecture ${options.architecture}`,
    );
  }

  const packageJsonPath = path.join(options.packageRoot, "package.json");
  const prebuildRoot = path.join(
    options.packageRoot,
    "prebuilds",
    `${options.platform}-${options.architecture}`,
  );
  assertOwnedEntry(options.operations, options.packageRoot, "directory");
  for (const filePath of [
    packageJsonPath,
    path.join(options.packageRoot, "lib", "index.js"),
    path.join(options.packageRoot, "lib", "utils.js"),
    path.join(options.packageRoot, "lib", "unixTerminal.js"),
    path.join(prebuildRoot, "pty.node"),
    path.join(prebuildRoot, "spawn-helper"),
  ]) {
    assertOwnedEntry(options.operations, filePath, "file");
  }
  assertOwnedEntry(options.operations, prebuildRoot, "directory");
  for (const unexpectedBuildPath of [
    path.join(options.packageRoot, "build", "Release"),
    path.join(options.packageRoot, "build", "Debug"),
  ]) {
    if (options.operations.exists(unexpectedBuildPath)) {
      throw new Error(
        `Packaged node-pty contains an unexpected build output: ${unexpectedBuildPath}`,
      );
    }
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(options.operations.readFile(packageJsonPath));
  } catch {
    throw new Error("Packaged node-pty package.json is invalid");
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    (metadata as { name?: unknown }).name !== "node-pty" ||
    (metadata as { version?: unknown }).version !== EXPECTED_NODE_PTY_VERSION ||
    (metadata as { main?: unknown }).main !== "./lib/index.js"
  ) {
    throw new Error(
      `Packaged node-pty metadata must be node-pty ${EXPECTED_NODE_PTY_VERSION} with ./lib/index.js`,
    );
  }
  return packageJsonPath;
}

export function createDeferredNodePtyLoader(
  options: DeferredNodePtyLoaderOptions,
): NodePtyModuleLoader {
  const extensionRoot = assertExtensionRoot(options.extensionRoot);
  const packageRoot = path.join(extensionRoot, STAGED_NODE_PTY_RELATIVE_PATH);
  const operations = options.fileOperations ?? defaultFileOperations;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  let loaded: NodePtyModule | undefined;

  return {
    load(): NodePtyModule {
      if (loaded) return loaded;
      const packageJsonPath = validateStagedPackage({
        packageRoot,
        platform,
        architecture,
        operations,
      });
      const requireFromPackage = (options.createRequire ?? createRequire)(
        packageJsonPath,
      );
      const candidate = requireFromPackage(packageRoot);
      if (!isNodePtyModule(candidate)) {
        throw new Error(
          "The packaged node-pty module does not expose the required spawn function",
        );
      }
      loaded = candidate;
      return loaded;
    },
  };
}

export type HostShellNodePtyLoadResult =
  | {
      mode: "native-fallback";
      plan: Extract<HostShellBootstrapPlan, { mode: "native-fallback" }>;
    }
  | {
      mode: "custom";
      plan: Exclude<HostShellBootstrapPlan, { mode: "native-fallback" }>;
      nodePty: NodePtyModule;
    };

export function loadNodePtyForHostShellPlan(
  plan: HostShellBootstrapPlan,
  loader: NodePtyModuleLoader,
): HostShellNodePtyLoadResult {
  if (plan.mode === "native-fallback") {
    return { mode: "native-fallback", plan };
  }
  return { mode: "custom", plan, nodePty: loader.load() };
}
