import * as fs from "fs";
import * as path from "path";

/** Canonicalize an existing path, or its nearest existing parent for a missing path. */
export function canonicalizePath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const missingSegments: string[] = [];
  let candidate = resolved;

  while (true) {
    try {
      return path.resolve(
        fs.realpathSync(candidate),
        ...missingSegments.reverse(),
      );
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return resolved;
      missingSegments.push(path.basename(candidate));
      candidate = parent;
    }
  }
}
