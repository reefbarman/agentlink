import { createHash } from "crypto";

/** Derives the stable Qdrant collection name for a workspace path. */
export function getAlCollectionName(workspacePath: string): string {
  const hash = createHash("sha256").update(workspacePath).digest("hex");
  return `al-${hash.substring(0, 16)}`;
}
