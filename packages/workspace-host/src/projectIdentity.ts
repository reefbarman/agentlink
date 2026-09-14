import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface WorkspaceProjectIdentity {
  readonly root: string;
  readonly id: string;
  readonly filesystemIdentity: {
    readonly device: string;
    readonly inode: string;
  };
}

export async function resolveWorkspaceProject(
  requestedRoot: string,
): Promise<WorkspaceProjectIdentity> {
  const absolute = path.resolve(requestedRoot);
  const root = await fs.realpath(absolute);
  const stats = await fs.stat(root, { bigint: true });
  if (!stats.isDirectory()) {
    throw new Error(`Project path is not a directory: ${requestedRoot}`);
  }
  const identity = `${root}\0${stats.dev.toString()}\0${stats.ino.toString()}`;
  return {
    root,
    id: createHash("sha256").update(identity).digest("hex"),
    filesystemIdentity: {
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
    },
  };
}
