import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";
import {
  projectLocationMarkerPath,
  readProjectLocationMarker,
  recordProjectLocation,
} from "./projectLocationMarker.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeProject(withAgentlink = true): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "location-marker-"));
  tempDirectories.push(directory);
  if (withAgentlink) fs.mkdirSync(path.join(directory, ".agentlink"));
  return directory;
}

const record = (name: string) => ({
  workspaceFolderUri: `file:///workspace/${name}`,
  rootPath: `/workspace/${name}`,
  displayName: name,
});

describe("project location marker", () => {
  it("does not create .agentlink in folders that never used AgentLink", () => {
    const root = makeProject(false);
    expect(recordProjectLocation(root, record("app"))).toBeUndefined();
    expect(fs.existsSync(path.join(root, ".agentlink"))).toBe(false);
  });

  it("records the current location and skips unchanged writes", () => {
    const root = makeProject();
    expect(recordProjectLocation(root, record("app"), 1)).toMatchObject({
      written: true,
      marker: { current: { ...record("app"), updatedAt: 1 }, previous: [] },
    });
    expect(recordProjectLocation(root, record("app"), 2)).toMatchObject({
      written: false,
    });
    expect(readProjectLocationMarker(root)?.current.updatedAt).toBe(1);
  });

  it("keeps previous locations newest first without duplicates", () => {
    const root = makeProject();
    recordProjectLocation(root, record("one"), 1);
    expect(
      recordProjectLocation(root, record("two"), 2)?.movedFrom,
    ).toMatchObject({ ...record("one"), lastSeenAt: 1 });
    recordProjectLocation(root, record("three"), 3);
    recordProjectLocation(root, record("one"), 4);

    expect(readProjectLocationMarker(root)).toMatchObject({
      current: record("one"),
      previous: [record("three"), record("two")],
    });
  });

  it("treats a display-name change as an update, not a move", () => {
    const root = makeProject();
    recordProjectLocation(root, record("app"), 1);
    const renamed = { ...record("app"), displayName: "App" };
    const result = recordProjectLocation(root, renamed, 2);
    expect(result?.movedFrom).toBeUndefined();
    expect(result?.marker.previous).toEqual([]);
  });

  it("ignores a malformed marker", () => {
    const root = makeProject();
    fs.writeFileSync(projectLocationMarkerPath(root), "{nope");
    expect(readProjectLocationMarker(root)).toBeUndefined();
    expect(recordProjectLocation(root, record("app"))?.written).toBe(true);
  });
});
