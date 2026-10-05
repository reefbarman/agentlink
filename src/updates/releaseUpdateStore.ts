import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  parseReleaseUpdateMetadata,
  parseReleaseVersion,
} from "./releaseSelection.js";

import type { ReleaseDiscovery } from "./githubReleaseClient.js";
import type { ReleaseUpdateIdentity } from "./releaseUpdateTypes.js";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface ReleaseUpdateCache {
  schemaVersion: 1;
  lastAttemptAt: number;
  checkedAt: number | null;
  retryAt: number | null;
  discovery: ReleaseDiscovery;
}

export class ReleaseUpdateStore {
  private readonly prefix: string;
  constructor(
    private readonly directory: string,
    private readonly identity: ReleaseUpdateIdentity,
  ) {
    const runtime =
      identity.product === "vscode"
        ? `-${identity.vscodeVersion?.replace(/[^a-z0-9.-]/g, "_") ?? "unknown"}`
        : "";
    this.prefix = `${identity.product}-${identity.target.replace(/[^a-z0-9-]/g, "_")}${runtime}`;
  }

  async readCache(): Promise<ReleaseUpdateCache | null> {
    const value = (await this.readJson(
      "cache",
      512 * 1024,
    )) as ReleaseUpdateCache | null;
    if (
      !value ||
      value.schemaVersion !== 1 ||
      !validTimestamp(value.lastAttemptAt) ||
      !(value.checkedAt === null || validTimestamp(value.checkedAt)) ||
      !(value.retryAt === null || validTimestamp(value.retryAt))
    )
      return null;
    const discovery = value.discovery;
    if (
      !discovery ||
      typeof discovery.complete !== "boolean" ||
      !Array.isArray(discovery.records) ||
      discovery.records.length > 100 ||
      !Array.isArray(discovery.unverifiedVersions) ||
      discovery.unverifiedVersions.length > 1000 ||
      !discovery.unverifiedVersions.every(
        (version) =>
          typeof version === "string" && parseReleaseVersion(version),
      )
    )
      return null;
    for (const record of discovery.records) {
      if (
        !record ||
        !record.metadata ||
        !parseReleaseUpdateMetadata(
          record.metadata,
          this.identity.product,
          record.metadata.tag,
        ) ||
        typeof record.prerelease !== "boolean" ||
        !Array.isArray(record.assets) ||
        record.assets.length > 100 ||
        !record.assets.every(
          (asset) => typeof asset === "string" && asset.length < 200,
        )
      )
        return null;
    }
    return value;
  }

  async readDismissal(): Promise<string | null> {
    const value = (await this.readJson("dismissal", 1024)) as {
      version?: unknown;
    } | null;
    return value &&
      typeof value.version === "string" &&
      parseReleaseVersion(value.version)
      ? value.version
      : null;
  }

  async writeCache(cache: ReleaseUpdateCache): Promise<void> {
    await this.writeJson("cache", cache);
  }
  async dismiss(version: string): Promise<void> {
    await this.writeJson("dismissal", { version });
  }

  async acquireRefresh(now: number): Promise<(() => Promise<void>) | null> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = this.filePath("refresh-lock");
    const token = randomUUID();
    const create = async () => {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ token, acquiredAt: now }));
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const current = JSON.parse(await readFile(lockPath, "utf8")) as {
            token?: string;
          };
          if (current.token === token) await unlink(lockPath);
        } catch {
          /* A stale lease may have been replaced. */
        }
      };
    };
    try {
      return await create();
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const recoveryPath = `${lockPath}.reclaim`;
      const recovery = await open(recoveryPath, "wx", 0o600).catch(
        (recoveryError: unknown) => {
          if (errorCode(recoveryError) === "EEXIST") return null;
          throw recoveryError;
        },
      );
      if (!recovery) return null;
      try {
        const info = await stat(lockPath).catch(() => null);
        if (info && now - info.mtimeMs <= 45_000) return null;
        if (info) await unlink(lockPath);
        try {
          return await create();
        } catch (retryError) {
          if (errorCode(retryError) === "EEXIST") return null;
          throw retryError;
        }
      } finally {
        await recovery.close();
        await unlink(recoveryPath).catch(() => undefined);
      }
    }
  }

  private filePath(kind: string): string {
    return path.join(this.directory, `${this.prefix}-${kind}.json`);
  }
  private async readJson(kind: string, limit: number): Promise<unknown> {
    try {
      const file = this.filePath(kind);
      if ((await stat(file)).size > limit) return null;
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      return null;
    }
  }
  private async writeJson(kind: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.filePath(kind);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
