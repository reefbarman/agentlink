import * as os from "node:os";
import * as path from "node:path";

import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

import { AGENTLINK_RESULT_RUN_PREFIX } from "../util/agentlinkTmpArtifacts.js";

export const TOOL_RESULT_ARTIFACT_PREFIX = AGENTLINK_RESULT_RUN_PREFIX;
export const DEFAULT_TOOL_RESULT_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TOOL_RESULT_ARTIFACT_RUN_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_TOOL_RESULT_ARTIFACT_RUN_MAX_COUNT = 32;
export const DEFAULT_TOOL_RESULT_ARTIFACT_STALE_AGE_MS = 24 * 60 * 60 * 1000;

export interface ToolResultArtifact {
  path: string;
  bytes: number;
  chars: number;
  sha256: string;
}

export interface ToolResultArtifactManagerOptions {
  tempDirectory?: string;
  maxArtifactBytes?: number;
  maxRunBytes?: number;
  maxRunCount?: number;
  staleAgeMs?: number;
  now?: () => number;
  createId?: () => string;
}

export class ToolResultArtifactManager {
  private rootPromise: Promise<string> | undefined;
  private bytesWritten = 0;
  private artifactsWritten = 0;

  constructor(
    private readonly options: ToolResultArtifactManagerOptions = {},
  ) {}

  async writeText(
    content: string,
    extension = "txt",
    signal?: AbortSignal,
  ): Promise<ToolResultArtifact | null> {
    const bytes = Buffer.byteLength(content, "utf8");
    const maxArtifactBytes =
      this.options.maxArtifactBytes ?? DEFAULT_TOOL_RESULT_ARTIFACT_MAX_BYTES;
    const maxRunBytes =
      this.options.maxRunBytes ?? DEFAULT_TOOL_RESULT_ARTIFACT_RUN_MAX_BYTES;
    const maxRunCount =
      this.options.maxRunCount ?? DEFAULT_TOOL_RESULT_ARTIFACT_RUN_MAX_COUNT;
    if (
      bytes > maxArtifactBytes ||
      this.bytesWritten + bytes > maxRunBytes ||
      this.artifactsWritten >= maxRunCount
    ) {
      return null;
    }

    this.bytesWritten += bytes;
    this.artifactsWritten += 1;
    let artifactPath: string | undefined;
    try {
      if (signal?.aborted) throw signal.reason;
      const root = await this.getRoot();
      if (signal?.aborted) throw signal.reason;
      const safeExtension = /^[a-z0-9]{1,12}$/i.test(extension)
        ? extension
        : "txt";
      const createId = this.options.createId ?? randomUUID;
      artifactPath = path.join(root, `${createId()}.${safeExtension}`);
      await writeFile(artifactPath, content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
        ...(signal ? { signal } : {}),
      });
      return {
        path: artifactPath,
        bytes,
        chars: countCodePoints(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    } catch (error) {
      const errorCode =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : undefined;
      if (artifactPath && errorCode !== "EEXIST") {
        await rm(artifactPath, { force: true }).catch(() => undefined);
      }
      this.bytesWritten -= bytes;
      this.artifactsWritten -= 1;
      return null;
    }
  }

  private getRoot(): Promise<string> {
    if (!this.rootPromise) {
      const creating = this.createRoot();
      this.rootPromise = creating;
      void creating.catch(() => {
        if (this.rootPromise === creating) this.rootPromise = undefined;
      });
    }
    return this.rootPromise;
  }

  private async createRoot(): Promise<string> {
    const tempDirectory = this.options.tempDirectory ?? os.tmpdir();
    await this.removeStaleRuns(tempDirectory);
    const root = await mkdtemp(
      path.join(tempDirectory, TOOL_RESULT_ARTIFACT_PREFIX),
    );
    await chmod(root, 0o700);
    return root;
  }

  private async removeStaleRuns(tempDirectory: string): Promise<void> {
    const staleAgeMs =
      this.options.staleAgeMs ?? DEFAULT_TOOL_RESULT_ARTIFACT_STALE_AGE_MS;
    if (staleAgeMs <= 0) return;

    let entries: string[];
    try {
      entries = await readdir(tempDirectory);
    } catch {
      return;
    }
    const cutoff = (this.options.now ?? Date.now)() - staleAgeMs;
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(TOOL_RESULT_ARTIFACT_PREFIX))
        .map(async (entry) => {
          const candidate = path.join(tempDirectory, entry);
          try {
            const info = await lstat(candidate);
            if (!info.isDirectory() || info.isSymbolicLink()) return;
            if (
              typeof process.getuid === "function" &&
              info.uid !== process.getuid()
            )
              return;
            const metadata = await stat(candidate);
            if (metadata.mtimeMs >= cutoff) return;
            await rm(candidate, { recursive: true, force: true });
          } catch {
            // Cleanup is opportunistic and must not block artifact retention.
          }
        }),
    );
  }
}

function countCodePoints(value: string): number {
  let count = 0;
  for (const _codePoint of value) count += 1;
  return count;
}
