import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomicFile.js";

/**
 * The format of the data root, recorded in `<dataRoot>/VERSION`. A server
 * migrates older data forward, one step at a time, at start; it refuses
 * data newer than it understands, so rolling back to older code never runs
 * it on migrated data (restore the backup taken before the upgrade
 * instead).
 *
 * To change the format: raise `DATA_VERSION` and add a migration whose `to`
 * is the new number. Migrations must be safe to run again after a crash
 * mid-way: `VERSION` is only written after each one finishes.
 */

export const DATA_VERSION = 1;
export const DATA_VERSION_FILE = "VERSION";

export interface DataMigration {
  /** The version this migration produces; it runs on `to - 1` data. */
  readonly to: number;
  readonly description: string;
  readonly run: (dataRoot: string) => Promise<void>;
}

/** None yet: version 1 is the format from before `VERSION` existed. */
export const DATA_MIGRATIONS: readonly DataMigration[] = [];

export class DataVersionError extends Error {
  constructor(
    readonly code: "data_too_new" | "data_version_unreadable",
    message: string,
  ) {
    super(message);
    this.name = "DataVersionError";
  }
}

/** The recorded version, or undefined when there is no `VERSION` yet. */
export async function readDataVersion(
  dataRoot: string,
): Promise<number | undefined> {
  const file = path.join(dataRoot, DATA_VERSION_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const version = Number(raw.trim());
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new DataVersionError(
      "data_version_unreadable",
      `${file} does not hold a data format version (found ${JSON.stringify(raw.trim().slice(0, 20))})`,
    );
  }
  return version;
}

/**
 * Bring the data root to `current`: record it for new or pre-`VERSION`
 * data, run the migrations in order for older data, and refuse newer data.
 */
export async function prepareDataVersion(options: {
  readonly dataRoot: string;
  readonly current?: number;
  readonly migrations?: readonly DataMigration[];
  readonly log?: (line: string) => void;
}): Promise<{ readonly from: number; readonly to: number }> {
  const current = options.current ?? DATA_VERSION;
  const migrations = [...(options.migrations ?? DATA_MIGRATIONS)].sort(
    (left, right) => left.to - right.to,
  );
  const log = options.log ?? (() => undefined);
  const file = path.join(options.dataRoot, DATA_VERSION_FILE);
  const write = (version: number) =>
    writeFileAtomic(file, `${version}\n`, 0o600);

  const recorded = await readDataVersion(options.dataRoot);
  if (recorded === undefined) {
    // Data from before VERSION existed is version 1; a new data root is
    // already the current format.
    const entries = await fs.readdir(options.dataRoot).catch(() => []);
    const from = entries.length > 0 ? 1 : current;
    if (from === current) {
      await write(current);
      return { from, to: current };
    }
    await write(from);
    return migrate(from);
  }
  if (recorded > current) {
    throw new DataVersionError(
      "data_too_new",
      `The data in ${options.dataRoot} is format ${recorded}, newer than this server understands (${current}). Run the version that wrote it, or restore the backup taken before the upgrade.`,
    );
  }
  return migrate(recorded);

  async function migrate(from: number) {
    let version = from;
    while (version < current) {
      const next = migrations.find((migration) => migration.to === version + 1);
      if (!next) {
        throw new Error(
          `No data migration from format ${version} to ${version + 1}`,
        );
      }
      log(`Migrating data to format ${next.to}: ${next.description}`);
      await next.run(options.dataRoot);
      await write(next.to);
      version = next.to;
    }
    return { from, to: version };
  }
}
