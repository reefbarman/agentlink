import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Read-only snapshots of repositories for chats (`read_repository`): the
 * files of a repository's default branch head, as a tar from the publisher
 * kept in `<dataRoot>/repository-snapshots`. The tar is indexed here and
 * never extracted, so nothing in it is written out, followed or run: only
 * regular files can be read, by their offset in the tar.
 *
 * A snapshot is reused for `reuseMs` (15 minutes), then fetched again, and
 * any snapshot older than `maxAgeMs` (24 hours) is deleted. Snapshots do
 * not outlive the process: the folder is emptied when the server starts.
 */

export const SNAPSHOT_REUSE_MS = 15 * 60 * 1_000;
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_SNAPSHOTS = 20;
/** Entries indexed per snapshot; the rest are left out (`truncated`). */
export const MAX_SNAPSHOT_FILES = 50_000;
const BLOCK = 512;

export interface SnapshotFile {
  readonly offset: number;
  readonly size: number;
}

export interface RepositorySnapshot {
  readonly repository: string;
  readonly branch: string;
  readonly commit: string;
  readonly fetchedAt: number;
  /** Regular files by path, sorted. */
  readonly files: ReadonlyMap<string, SnapshotFile>;
  /** More entries than `MAX_SNAPSHOT_FILES`. */
  readonly truncated: boolean;
  /** Up to `maxBytes` of a file. */
  read(filePath: string, maxBytes: number): Promise<Buffer>;
}

export interface RepositorySnapshots {
  get(
    repository: string,
    options?: { readonly refresh?: boolean },
  ): Promise<RepositorySnapshot>;
  /** Delete snapshots older than the maximum age. */
  sweep(): Promise<void>;
}

/** Fetches a tar of `repository` to `destination`. */
export type FetchArchive = (
  repository: string,
  destination: string,
) => Promise<{ readonly branch: string; readonly commit: string }>;

export class SnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotFormatError";
  }
}

interface Stored extends RepositorySnapshot {
  readonly file: string;
}

export async function openRepositorySnapshots(options: {
  readonly root: string;
  readonly fetchArchive: FetchArchive;
  readonly now?: () => number;
  readonly reuseMs?: number;
  readonly maxAgeMs?: number;
}): Promise<RepositorySnapshots> {
  const now = options.now ?? Date.now;
  const reuseMs = options.reuseMs ?? SNAPSHOT_REUSE_MS;
  const maxAgeMs = options.maxAgeMs ?? SNAPSHOT_MAX_AGE_MS;
  await fs.rm(options.root, { recursive: true, force: true });
  await fs.mkdir(options.root, { recursive: true, mode: 0o700 });
  const snapshots = new Map<string, Stored>();
  const loading = new Map<string, Promise<Stored>>();
  // Keeps file names unique even for fetches in the same millisecond.
  let sequence = 0;

  const drop = async (key: string, stored: Stored) => {
    if (snapshots.get(key) === stored) snapshots.delete(key);
    await fs.rm(stored.file, { force: true });
  };

  const sweep = async () => {
    for (const [key, stored] of snapshots) {
      if (now() - stored.fetchedAt >= maxAgeMs) await drop(key, stored);
    }
  };

  const fetchSnapshot = async (repository: string, key: string) => {
    const fetchedAt = now();
    sequence += 1;
    const file = path.join(
      options.root,
      `${createHash("sha256").update(key).digest("hex").slice(0, 16)}-${fetchedAt}-${sequence}.tar`,
    );
    try {
      const { branch, commit } = await options.fetchArchive(repository, file);
      const { files, truncated } = await indexTar(file);
      const stored: Stored = {
        repository,
        branch,
        commit,
        fetchedAt,
        files,
        truncated,
        file,
        read: async (filePath, maxBytes) => {
          const entry = files.get(filePath);
          if (!entry) throw new Error(`No file ${filePath}`);
          return readAt(file, entry.offset, Math.min(entry.size, maxBytes));
        },
      };
      const previous = snapshots.get(key);
      snapshots.set(key, stored);
      if (previous) await fs.rm(previous.file, { force: true });
      // Oldest first beyond the limit.
      while (snapshots.size > MAX_SNAPSHOTS) {
        const [oldestKey, oldest] = [...snapshots].sort(
          (left, right) => left[1].fetchedAt - right[1].fetchedAt,
        )[0]!;
        await drop(oldestKey, oldest);
      }
      return stored;
    } catch (error) {
      await fs.rm(file, { force: true });
      throw error;
    }
  };

  return {
    async get(repository, getOptions) {
      await sweep();
      const key = repository.toLowerCase();
      const current = snapshots.get(key);
      if (
        current &&
        !getOptions?.refresh &&
        now() - current.fetchedAt < reuseMs
      ) {
        return current;
      }
      let pending = loading.get(key);
      if (!pending) {
        pending = fetchSnapshot(repository, key).finally(() =>
          loading.delete(key),
        );
        loading.set(key, pending);
      }
      return pending;
    },
    sweep,
  };
}

async function readAt(
  file: string,
  offset: number,
  length: number,
): Promise<Buffer> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** A path from a tar entry, or undefined for one that could escape. */
export function normalizeEntryPath(raw: string): string | undefined {
  const trimmed = raw.replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\0")) {
    return undefined;
  }
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return undefined;
  }
  return parts.join("/");
}

function field(header: Buffer, start: number, length: number): string {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? length : end).toString("utf8");
}

function numberField(header: Buffer, start: number, length: number): number {
  // Base-256 for large values (high bit set), octal text otherwise.
  if (header[start]! & 0x80) {
    let value = header[start]! & 0x7f;
    for (let index = start + 1; index < start + length; index += 1) {
      value = value * 256 + header[index]!;
    }
    return value;
  }
  const text = field(header, start, length).trim();
  if (!/^[0-7]*$/u.test(text)) {
    throw new SnapshotFormatError("Archive header is not a tar header");
  }
  return text ? Number.parseInt(text, 8) : 0;
}

/** `path` from a pax extended header's records, if it sets one. */
function paxPath(records: string): string | undefined {
  let rest = records;
  let found: string | undefined;
  while (rest.length > 0) {
    const space = rest.indexOf(" ");
    const length = Number.parseInt(rest.slice(0, space), 10);
    if (space < 0 || !Number.isFinite(length) || length <= space) break;
    const record = rest.slice(space + 1, length - 1);
    rest = rest.slice(length);
    const equals = record.indexOf("=");
    if (record.slice(0, equals) === "path") found = record.slice(equals + 1);
  }
  return found;
}

/** Index a tar's regular files without extracting anything. */
export async function indexTar(
  file: string,
): Promise<{ files: Map<string, SnapshotFile>; truncated: boolean }> {
  const handle = await fs.open(file, "r");
  const files = new Map<string, SnapshotFile>();
  let truncated = false;
  try {
    const { size: total } = await handle.stat();
    let offset = 0;
    let nextPath: string | undefined;
    let entries = 0;
    const header = Buffer.alloc(BLOCK);
    while (offset + BLOCK <= total) {
      await handle.read(header, 0, BLOCK, offset);
      if (header.every((byte) => byte === 0)) break;
      const size = numberField(header, 124, 12);
      const type = String.fromCharCode(header[156]!);
      const dataOffset = offset + BLOCK;
      if (dataOffset + size > total) {
        throw new SnapshotFormatError("Archive ends inside a file");
      }
      if (type === "x") {
        const data = Buffer.alloc(size);
        await handle.read(data, 0, size, dataOffset);
        nextPath = paxPath(data.toString("utf8"));
      } else if (type !== "g") {
        const name = field(header, 0, 100);
        const prefix =
          field(header, 257, 6) === "ustar" ? field(header, 345, 155) : "";
        const raw = nextPath ?? (prefix ? `${prefix}/${name}` : name);
        nextPath = undefined;
        const entryPath = normalizeEntryPath(raw);
        // Regular files only: links and folders are never read through.
        if (entryPath && (type === "0" || type === "\0")) {
          entries += 1;
          if (entries > MAX_SNAPSHOT_FILES) {
            truncated = true;
            break;
          }
          files.set(entryPath, { offset: dataOffset, size });
        }
      }
      offset = dataOffset + Math.ceil(size / BLOCK) * BLOCK;
    }
  } finally {
    await handle.close();
  }
  return {
    files: new Map(
      [...files].sort(([left], [right]) => (left < right ? -1 : 1)),
    ),
    truncated,
  };
}
