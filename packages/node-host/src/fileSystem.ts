import { constants, promises as fs, type Stats } from "node:fs";

export type NodeHostFileKind = "file" | "directory" | "symlink" | "other";

/** Serialisable file metadata. `stat` follows links; `lstat` does not. */
export interface NodeHostFileStat {
  readonly kind: NodeHostFileKind;
  readonly size: number;
  readonly nlink: number;
  readonly mode: number;
  readonly mtimeMs: number;
}

export interface NodeHostDirectoryEntry {
  readonly name: string;
  readonly kind: NodeHostFileKind;
}

/**
 * Primitive filesystem operations used by the Node host file tools. Policy,
 * grant checks, baseline hashes, write locks, and post-write verification
 * stay in the calling tool; an implementation only performs the operation.
 *
 * Paths are absolute in the host's canonical namespace. A remote
 * implementation must map them onto its own storage consistently, including
 * `realpath` results. Failures must reject with an error carrying the Node
 * `code` (for example `ENOENT` or `EEXIST`), because lock and precondition
 * logic depends on it.
 */
export interface NodeHostFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<NodeHostFileStat>;
  lstat(path: string): Promise<NodeHostFileStat>;
  readFile(path: string): Promise<Buffer>;
  readDirectory(path: string): Promise<readonly NodeHostDirectoryEntry[]>;
  /** Create one directory; the parent must exist. */
  mkdir(path: string, options: { readonly mode: number }): Promise<void>;
  /**
   * Exclusively create a new file (never following a final symlink), write
   * the complete content, fsync, and close. Rejects with `EEXIST` when the
   * path exists.
   */
  createFile(
    path: string,
    content: string | Uint8Array,
    options: { readonly mode: number },
  ): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** fsync a directory so a completed rename is durable. */
  syncDirectory(path: string): Promise<void>;
  /** Whether the current identity may execute the file. Never rejects. */
  canExecute(path: string): Promise<boolean>;
}

/** Default implementation backed by this machine's filesystem. */
export function createNodeHostLocalFileSystem(): NodeHostFileSystem {
  return {
    realpath: (target) => fs.realpath(target),
    stat: async (target) => toFileStat(await fs.stat(target)),
    lstat: async (target) => toFileStat(await fs.lstat(target)),
    readFile: (target) => fs.readFile(target),
    async readDirectory(target) {
      return (await fs.readdir(target, { withFileTypes: true })).map(
        (entry) => ({
          name: entry.name,
          kind: entry.isSymbolicLink()
            ? "symlink"
            : entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                : "other",
        }),
      );
    },
    async mkdir(target, options) {
      await fs.mkdir(target, { mode: options.mode });
    },
    async createFile(target, content, options) {
      const handle = await fs.open(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        options.mode,
      );
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    link: (existingPath, newPath) => fs.link(existingPath, newPath),
    rename: (from, to) => fs.rename(from, to),
    unlink: (target) => fs.unlink(target),
    chmod: (target, mode) => fs.chmod(target, mode),
    async syncDirectory(target) {
      const handle = await fs.open(target, constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    canExecute: (target) =>
      fs
        .access(target, constants.X_OK)
        .then(() => true)
        .catch(() => false),
  };
}

function toFileStat(stats: Stats): NodeHostFileStat {
  return {
    kind: stats.isSymbolicLink()
      ? "symlink"
      : stats.isDirectory()
        ? "directory"
        : stats.isFile()
          ? "file"
          : "other",
    size: stats.size,
    nlink: stats.nlink,
    mode: stats.mode,
    mtimeMs: stats.mtimeMs,
  };
}
