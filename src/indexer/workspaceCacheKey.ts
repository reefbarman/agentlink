import { createHash } from "crypto";

/** Derives the stable cache key for a workspace path. */
export function getWorkspaceCacheKey(workspacePath: string): string {
  const hash = createHash("sha256").update(workspacePath).digest("hex");
  return `al-${hash.substring(0, 16)}`;
}
