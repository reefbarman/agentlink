import * as fs from "fs";
import * as path from "path";

import { randomUUID } from "crypto";

export interface AtomicFileOperations {
  mkdirSync(
    path: fs.PathLike,
    options: fs.MakeDirectoryOptions & { recursive: true },
  ): string | undefined;
  openSync(path: fs.PathLike, flags: fs.OpenMode): number;
  writeFileSync(
    file: number,
    data: string,
    options: { encoding: BufferEncoding },
  ): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(oldPath: fs.PathLike, newPath: fs.PathLike): void;
  rmSync(path: fs.PathLike, options: { force: true }): void;
}

const defaultOperations: AtomicFileOperations = fs;

export function writeAtomicJsonFile(
  targetPath: string,
  value: unknown,
  operations: AtomicFileOperations = defaultOperations,
  platform: NodeJS.Platform = process.platform,
): void {
  const serialized = JSON.stringify(value);
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let temporaryFd: number | undefined;
  let ownsTemporaryPath = false;

  operations.mkdirSync(directory, { recursive: true });
  try {
    temporaryFd = operations.openSync(temporaryPath, "wx");
    ownsTemporaryPath = true;
    operations.writeFileSync(temporaryFd, serialized, {
      encoding: "utf8",
    });
    operations.fsyncSync(temporaryFd);
    operations.closeSync(temporaryFd);
    temporaryFd = undefined;

    operations.renameSync(temporaryPath, targetPath);
    ownsTemporaryPath = false;
    fsyncDirectory(directory, operations, platform);
  } catch (error) {
    if (temporaryFd !== undefined) {
      try {
        operations.closeSync(temporaryFd);
      } catch {
        // Preserve the original checkpoint failure.
      }
    }
    if (ownsTemporaryPath) {
      try {
        operations.rmSync(temporaryPath, { force: true });
      } catch {
        // Preserve the original checkpoint failure.
      }
    }
    throw error;
  }
}

function fsyncDirectory(
  directory: string,
  operations: AtomicFileOperations,
  platform: NodeJS.Platform,
): void {
  let directoryFd: number;
  try {
    directoryFd = operations.openSync(directory, "r");
  } catch (error) {
    if (isUnsupportedWindowsDirectoryOpen(error, platform)) return;
    throw error;
  }

  let primaryError: unknown;
  try {
    operations.fsyncSync(directoryFd);
  } catch (error) {
    primaryError = error;
  }
  try {
    operations.closeSync(directoryFd);
  } catch (error) {
    if (primaryError === undefined) throw error;
  }
  if (primaryError !== undefined) throw primaryError;
}

function isUnsupportedWindowsDirectoryOpen(
  error: unknown,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32" || !(error instanceof Error) || !("code" in error)) {
    return false;
  }
  return ["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes(
    String((error as NodeJS.ErrnoException).code),
  );
}
