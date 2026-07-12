import * as fs from "fs/promises";
import * as path from "path";

import { randomUUID } from "crypto";

export interface AtomicFileOperations {
  mkdir(dirPath: string, options: { recursive: true }): Promise<unknown>;
  writeFile(
    filePath: string,
    content: string,
    options: { encoding: "utf-8"; mode: number },
  ): Promise<unknown>;
  rename(oldPath: string, newPath: string): Promise<unknown>;
  rm(filePath: string, options: { force: true }): Promise<unknown>;
}

const defaultFileOperations: AtomicFileOperations = {
  mkdir: (dirPath, options) => fs.mkdir(dirPath, options),
  writeFile: (filePath, content, options) =>
    fs.writeFile(filePath, content, options),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  rm: (filePath, options) => fs.rm(filePath, options),
};

export interface AtomicWriteTextFileOptions {
  mode: number;
  fileOperations?: AtomicFileOperations;
  createTempId?: () => string;
}

export async function writeTextFileAtomic(
  filePath: string,
  content: string,
  options: AtomicWriteTextFileOptions,
): Promise<void> {
  const fileOperations = options.fileOperations ?? defaultFileOperations;
  await fileOperations.mkdir(path.dirname(filePath), { recursive: true });
  const tempId = (options.createTempId ?? randomUUID)();
  const tempPath = `${filePath}.tmp.${process.pid}.${tempId}`;
  let renamed = false;
  try {
    await fileOperations.writeFile(tempPath, content, {
      encoding: "utf-8",
      mode: options.mode,
    });
    await fileOperations.rename(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await fileOperations.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}
