import * as fs from "fs";
import * as path from "path";

/**
 * POSIX hosts use the native realpath(3), which also canonicalizes letter case
 * on case-insensitive volumes (APFS, SMB). The JavaScript implementation keeps
 * the caller's casing, so `/Volumes/config/x` and `/Volumes/CONFIG/x` would
 * compare as different files. Windows keeps the JavaScript implementation
 * because its native variant can rewrite mapped drives to UNC paths.
 */
const realpath: (target: string) => string =
  process.platform === "win32"
    ? (target) => fs.realpathSync(target)
    : (target) => fs.realpathSync.native(target);

/** Canonicalize an existing path, or its nearest existing parent for a missing path. */
export function canonicalizePath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const missingSegments: string[] = [];
  let candidate = resolved;

  while (true) {
    try {
      return path.resolve(realpath(candidate), ...missingSegments.reverse());
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return resolved;
      missingSegments.push(path.basename(candidate));
      candidate = parent;
    }
  }
}
