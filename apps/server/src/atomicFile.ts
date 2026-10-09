import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Replace a file atomically: write a private temporary file, fsync it,
 * rename it over the target, then fsync the directory so the rename is
 * durable before the caller reports success.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  await syncDirectory(path.dirname(filePath));
}

export async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await fs.open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
