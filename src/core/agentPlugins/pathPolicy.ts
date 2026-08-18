import type { PluginPackageFileSystem } from "./contracts.js";
import path from "node:path";

export type AgentPluginPathPolicyResult =
  | {
      readonly ok: true;
      readonly lexicalPath: string;
      readonly resolvedPath: string;
      readonly existingPath: string;
      readonly missingSegments: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code:
        | "invalid_relative_path"
        | "lexical_escape"
        | "realpath_escape";
      readonly message: string;
    };

export function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export async function resolvePackagePath(
  fileSystem: PluginPackageFileSystem,
  rootPath: string,
  relativePath: string,
): Promise<AgentPluginPathPolicyResult> {
  if (!relativePath.startsWith("./")) {
    return {
      ok: false,
      code: "invalid_relative_path",
      message: "Plugin-relative paths must begin with './'.",
    };
  }
  return resolveContainedPath(
    fileSystem,
    rootPath,
    path.resolve(rootPath, relativePath.slice(2)),
  );
}

export async function resolveContainedPath(
  fileSystem: PluginPackageFileSystem,
  rootPath: string,
  candidatePath: string,
): Promise<AgentPluginPathPolicyResult> {
  const realRoot = await fileSystem.realpath(rootPath);
  const lexicalPath = path.resolve(candidatePath);
  if (!isPathWithin(lexicalPath, path.resolve(rootPath))) {
    return {
      ok: false,
      code: "lexical_escape",
      message: "Path escapes the plugin root lexically.",
    };
  }

  const missingSegments: string[] = [];
  let existingPath = lexicalPath;
  while (!(await pathExists(fileSystem, existingPath))) {
    const parent = path.dirname(existingPath);
    if (parent === existingPath) {
      return {
        ok: false,
        code: "realpath_escape",
        message: "No existing ancestor could establish package containment.",
      };
    }
    missingSegments.unshift(path.basename(existingPath));
    existingPath = parent;
  }

  const realExisting = await fileSystem.realpath(existingPath);
  if (!isPathWithin(realExisting, realRoot)) {
    return {
      ok: false,
      code: "realpath_escape",
      message: "Path resolves outside the plugin root.",
    };
  }

  const resolvedPath = path.join(realExisting, ...missingSegments);
  if (!isPathWithin(resolvedPath, realRoot)) {
    return {
      ok: false,
      code: "realpath_escape",
      message: "Resolved path escapes the plugin root.",
    };
  }

  return {
    ok: true,
    lexicalPath,
    resolvedPath,
    existingPath: realExisting,
    missingSegments,
  };
}

export async function resolveRootedRuntimePath(
  fileSystem: PluginPackageFileSystem,
  input: string,
  roots: { readonly pluginRoot: string; readonly pluginData: string },
): Promise<AgentPluginPathPolicyResult> {
  if (input.startsWith("./")) {
    return resolvePackagePath(fileSystem, roots.pluginRoot, input);
  }

  for (const [placeholder, root] of [
    ["${PLUGIN_ROOT}", roots.pluginRoot],
    ["${PLUGIN_DATA}", roots.pluginData],
  ] as const) {
    if (input === placeholder || input.startsWith(`${placeholder}/`)) {
      const suffix = input.slice(placeholder.length).replace(/^\//u, "");
      return resolveContainedPath(fileSystem, root, path.resolve(root, suffix));
    }
  }

  return {
    ok: false,
    code: "invalid_relative_path",
    message:
      "Working directory must begin with './', '${PLUGIN_ROOT}', or '${PLUGIN_DATA}'.",
  };
}

async function pathExists(
  fileSystem: PluginPackageFileSystem,
  candidate: string,
): Promise<boolean> {
  try {
    await fileSystem.lstat(candidate);
    return true;
  } catch {
    return false;
  }
}
