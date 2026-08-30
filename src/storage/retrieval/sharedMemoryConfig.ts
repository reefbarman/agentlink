import * as fs from "fs/promises";
import * as path from "path";

import { randomUUID } from "crypto";

export type SharedMemoryMode = "off" | "autonomous";

export type SharedMemoryConfigReason = "config_invalid" | "config_unreadable";

export interface SharedMemoryConfigSnapshot {
  mode: SharedMemoryMode;
  reason?: SharedMemoryConfigReason;
}

export const DEFAULT_SHARED_MEMORY_MODE: SharedMemoryMode = "autonomous";

export interface SharedMemoryConfigFileOperations {
  stat(filePath: string): Promise<{ mtimeMs: number; size: number }>;
  readFile(filePath: string): Promise<string>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<unknown>;
  writeFile(
    filePath: string,
    content: string,
    options: { encoding: "utf-8"; mode: number; flag?: "wx" },
  ): Promise<unknown>;
  rename(oldPath: string, newPath: string): Promise<unknown>;
  rm(filePath: string, options: { force: true }): Promise<unknown>;
}

const defaultFileOperations: SharedMemoryConfigFileOperations = {
  stat: (filePath) => fs.stat(filePath),
  readFile: (filePath) => fs.readFile(filePath, "utf-8"),
  mkdir: (dirPath, options) => fs.mkdir(dirPath, options),
  writeFile: (filePath, content, options) =>
    fs.writeFile(filePath, content, options),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  rm: (filePath, options) => fs.rm(filePath, options),
};

export interface SharedMemoryConfigStoreOptions {
  fileOperations?: SharedMemoryConfigFileOperations;
  createTempId?: () => string;
}

export class SharedMemoryConfigStore {
  private readonly fileOperations: SharedMemoryConfigFileOperations;
  private readonly createTempId: () => string;
  private cache:
    | { mtimeMs: number; size: number; snapshot: SharedMemoryConfigSnapshot }
    | undefined;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly configPath: string,
    options: SharedMemoryConfigStoreOptions = {},
  ) {
    this.fileOperations = options.fileOperations ?? defaultFileOperations;
    this.createTempId = options.createTempId ?? randomUUID;
  }

  async read(): Promise<SharedMemoryConfigSnapshot> {
    let stat: { mtimeMs: number; size: number };
    try {
      stat = await this.fileOperations.stat(this.configPath);
    } catch (error) {
      this.cache = undefined;
      return isMissingFileError(error)
        ? { mode: DEFAULT_SHARED_MEMORY_MODE }
        : { mode: "off", reason: "config_unreadable" };
    }
    if (
      this.cache &&
      this.cache.mtimeMs === stat.mtimeMs &&
      this.cache.size === stat.size
    ) {
      return { ...this.cache.snapshot };
    }
    let snapshot: SharedMemoryConfigSnapshot;
    try {
      snapshot = parseSharedMemoryConfig(
        await this.fileOperations.readFile(this.configPath),
      );
    } catch (error) {
      this.cache = undefined;
      return isMissingFileError(error)
        ? { mode: DEFAULT_SHARED_MEMORY_MODE }
        : { mode: "off", reason: "config_unreadable" };
    }
    this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, snapshot };
    return { ...snapshot };
  }

  write(mode: SharedMemoryMode): Promise<void> {
    const write = this.writeQueue.then(
      () => this.performWrite(mode),
      () => this.performWrite(mode),
    );
    this.writeQueue = write;
    return write;
  }

  /** Creates the config only when absent. Returns true when this call seeded it. */
  seed(mode: SharedMemoryMode): Promise<boolean> {
    const seed = this.writeQueue.then(
      () => this.performSeed(mode),
      () => this.performSeed(mode),
    );
    this.writeQueue = seed;
    return seed;
  }

  private async performWrite(mode: SharedMemoryMode): Promise<void> {
    await this.fileOperations.mkdir(path.dirname(this.configPath), {
      recursive: true,
    });
    const tempPath = `${this.configPath}.tmp.${process.pid}.${this.createTempId()}`;
    let renamed = false;
    try {
      await this.fileOperations.writeFile(tempPath, serialize(mode), {
        encoding: "utf-8",
        mode: 0o600,
      });
      await this.fileOperations.rename(tempPath, this.configPath);
      renamed = true;
    } finally {
      if (!renamed) {
        await this.fileOperations
          .rm(tempPath, { force: true })
          .catch(() => undefined);
      }
    }
    this.cache = undefined;
  }

  private async performSeed(mode: SharedMemoryMode): Promise<boolean> {
    await this.fileOperations.mkdir(path.dirname(this.configPath), {
      recursive: true,
    });
    try {
      await this.fileOperations.writeFile(this.configPath, serialize(mode), {
        encoding: "utf-8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if (isAlreadyExistsError(error)) return false;
      throw error;
    }
    this.cache = undefined;
    return true;
  }
}

function serialize(mode: SharedMemoryMode): string {
  return `${JSON.stringify({ mode }, null, 2)}\n`;
}

function parseSharedMemoryConfig(content: string): SharedMemoryConfigSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { mode: "off", reason: "config_invalid" };
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("mode" in parsed) ||
    ((parsed as { mode: unknown }).mode !== "off" &&
      (parsed as { mode: unknown }).mode !== "autonomous")
  ) {
    return { mode: "off", reason: "config_invalid" };
  }
  return { mode: (parsed as { mode: SharedMemoryMode }).mode };
}

function isMissingFileError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function isAlreadyExistsError(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    String((error as { code?: unknown }).code) === code
  );
}
