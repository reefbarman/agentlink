import * as fs from "node:fs/promises";

import type {
  PluginPackageDirectoryEntry,
  PluginPackageFileStat,
  PluginPackageFileSystem,
} from "../core/agentPlugins/contracts.js";

function classifyStat(value: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): PluginPackageFileStat["kind"] {
  if (value.isFile()) return "file";
  if (value.isDirectory()) return "directory";
  if (value.isSymbolicLink()) return "symlink";
  return "other";
}

export function createNodePluginPackageFileSystem(): PluginPackageFileSystem {
  return {
    readFile: (filePath) => fs.readFile(filePath, "utf8"),
    async readdir(directoryPath) {
      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      return entries.map(
        (entry): PluginPackageDirectoryEntry => ({
          name: entry.name,
          kind: classifyStat(entry),
        }),
      );
    },
    async lstat(filePath) {
      return { kind: classifyStat(await fs.lstat(filePath)) };
    },
    async stat(filePath) {
      return { kind: classifyStat(await fs.stat(filePath)) };
    },
    realpath: (filePath) => fs.realpath(filePath),
  };
}
