import { promises as fs, constants as fsConstants } from "node:fs";

import { HttpError } from "./httpJson.js";
import path from "node:path";

/**
 * Read-only file access for the app's file viewer: one text file inside a
 * project, for the owner who clicked a file link in a chat. The path may be
 * relative to the project or absolute inside it; symlinks are resolved and
 * the real file must still be inside the project's real root. Directories,
 * special files, and binary files are refused, and reads are bounded.
 */

export const MAX_PROJECT_FILE_BYTES = 1024 * 1024;
const MAX_PATH_LENGTH = 4096;

export interface ProjectFile {
  /** Path relative to the project root, with `/` separators. */
  readonly path: string;
  readonly size: number;
  readonly content: string;
  /** The file is larger than the limit; `content` is its start. */
  readonly truncated: boolean;
}

export async function readProjectFile(
  root: string,
  requested: string,
  maxBytes = MAX_PROJECT_FILE_BYTES,
): Promise<ProjectFile> {
  const trimmed = requested.trim();
  if (!trimmed || trimmed.length > MAX_PATH_LENGTH || trimmed.includes("\0")) {
    throw new HttpError(400, "path_invalid");
  }
  const realRoot = await fs.realpath(root);
  const configuredRoot = path.resolve(root);
  // Lexical check first, so paths outside the project are refused without
  // revealing whether they exist. Absolute paths may use the configured root
  // (what the agent sees) or its resolved form.
  let candidate: string;
  if (!path.isAbsolute(trimmed)) {
    candidate = path.resolve(realRoot, trimmed);
  } else if (isInside(configuredRoot, path.resolve(trimmed))) {
    candidate = path.join(
      realRoot,
      path.relative(configuredRoot, path.resolve(trimmed)),
    );
  } else {
    candidate = path.resolve(trimmed);
  }
  if (!isInside(realRoot, candidate)) {
    throw new HttpError(403, "outside_project");
  }
  // Resolve symlinks: the file itself must also be inside the project.
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(String(errorCode(error)))) {
      throw new HttpError(404, "file_not_found");
    }
    throw error;
  }
  if (!isInside(realRoot, real)) {
    throw new HttpError(403, "outside_project");
  }
  const handle = await fs
    .open(real, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0))
    .catch((error: unknown) => {
      if (errorCode(error) === "EISDIR") {
        throw new HttpError(400, "not_a_file");
      }
      throw error;
    });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new HttpError(400, "not_a_file");
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new HttpError(415, "binary_file");
    return {
      path: path.relative(realRoot, real).split(path.sep).join("/"),
      size: stat.size,
      content: bytes.toString("utf8"),
      truncated: stat.size > bytesRead,
    };
  } finally {
    await handle.close();
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative))
  );
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
