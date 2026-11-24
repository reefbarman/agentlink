import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * `.agentlink/location.json` records where a project folder was last opened.
 * The file moves with the folder, so after a rename or move AgentLink can see
 * the previous location and offer to migrate session history recorded there.
 * It holds machine-local absolute paths and is Git-ignored.
 */
export const PROJECT_LOCATION_MARKER_FILE = "location.json";
const MAX_PREVIOUS_LOCATIONS = 10;

export interface ProjectLocationRecord {
  /** Normalized workspace-folder URI used as the project identity. */
  workspaceFolderUri: string;
  rootPath: string;
  displayName: string;
}

export interface PreviousProjectLocation extends ProjectLocationRecord {
  lastSeenAt: number;
}

export interface ProjectLocationMarker {
  version: 1;
  current: ProjectLocationRecord & { updatedAt: number };
  previous: PreviousProjectLocation[];
}

export function projectLocationMarkerPath(rootPath: string): string {
  return path.join(rootPath, ".agentlink", PROJECT_LOCATION_MARKER_FILE);
}

export function readProjectLocationMarker(
  rootPath: string,
): ProjectLocationMarker | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(projectLocationMarkerPath(rootPath), "utf-8"),
    ) as Partial<ProjectLocationMarker>;
    if (parsed.version !== 1 || !isLocationRecord(parsed.current)) {
      return undefined;
    }
    const previous = Array.isArray(parsed.previous)
      ? parsed.previous.filter(
          (entry): entry is PreviousProjectLocation =>
            isLocationRecord(entry) && typeof entry.lastSeenAt === "number",
        )
      : [];
    return {
      version: 1,
      current: {
        ...pickRecord(parsed.current),
        updatedAt:
          typeof parsed.current.updatedAt === "number"
            ? parsed.current.updatedAt
            : 0,
      },
      previous,
    };
  } catch {
    return undefined;
  }
}

export interface RecordProjectLocationResult {
  marker: ProjectLocationMarker;
  /** Set when this call observed a different previous current location. */
  movedFrom?: PreviousProjectLocation;
  written: boolean;
}

/**
 * Records `current` as the folder's location. A different previously recorded
 * location is kept in `previous`. Does nothing when the folder has no
 * `.agentlink` directory, so folders never used with AgentLink stay untouched.
 */
export function recordProjectLocation(
  rootPath: string,
  current: ProjectLocationRecord,
  now: number = Date.now(),
): RecordProjectLocationResult | undefined {
  const agentlinkDirectory = path.join(rootPath, ".agentlink");
  try {
    if (!fs.statSync(agentlinkDirectory).isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const existing = readProjectLocationMarker(rootPath);
  const unchanged =
    existing !== undefined && sameRecord(existing.current, current);
  if (unchanged) return { marker: existing, written: false };

  const movedFrom =
    existing && !sameLocation(existing.current, current)
      ? {
          ...pickRecord(existing.current),
          lastSeenAt: existing.current.updatedAt,
        }
      : undefined;
  const previous = [
    ...(movedFrom ? [movedFrom] : []),
    ...(existing?.previous ?? []),
  ]
    .filter((entry) => !sameLocation(entry, current))
    .filter(
      (entry, index, all) =>
        all.findIndex(
          (other) => other.workspaceFolderUri === entry.workspaceFolderUri,
        ) === index,
    )
    .slice(0, MAX_PREVIOUS_LOCATIONS);

  const marker: ProjectLocationMarker = {
    version: 1,
    current: { ...pickRecord(current), updatedAt: now },
    previous,
  };
  writeJsonAtomicSync(projectLocationMarkerPath(rootPath), marker);
  return { marker, ...(movedFrom ? { movedFrom } : {}), written: true };
}

function sameLocation(
  left: ProjectLocationRecord,
  right: ProjectLocationRecord,
): boolean {
  return (
    left.workspaceFolderUri === right.workspaceFolderUri ||
    path.resolve(left.rootPath) === path.resolve(right.rootPath)
  );
}

function sameRecord(
  left: ProjectLocationRecord,
  right: ProjectLocationRecord,
): boolean {
  return (
    left.workspaceFolderUri === right.workspaceFolderUri &&
    left.rootPath === right.rootPath &&
    left.displayName === right.displayName
  );
}

function pickRecord(record: ProjectLocationRecord): ProjectLocationRecord {
  return {
    workspaceFolderUri: record.workspaceFolderUri,
    rootPath: record.rootPath,
    displayName: record.displayName,
  };
}

function isLocationRecord(value: unknown): value is ProjectLocationRecord {
  const record = value as Partial<ProjectLocationRecord> | undefined;
  return (
    typeof record?.workspaceFolderUri === "string" &&
    record.workspaceFolderUri.length > 0 &&
    typeof record.rootPath === "string" &&
    record.rootPath.length > 0 &&
    typeof record.displayName === "string"
  );
}

function writeJsonAtomicSync(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(tempPath, filePath);
}
