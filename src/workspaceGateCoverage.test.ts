import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  workspaces?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
}

const ROOT = path.resolve(__dirname, "..");

function readManifest(directory: string): PackageManifest {
  return JSON.parse(
    fs.readFileSync(path.join(directory, "package.json"), "utf8"),
  ) as PackageManifest;
}

function resolveWorkspaceDirectories(patterns: string[]): string[] {
  const directories: string[] = [];
  for (const pattern of patterns) {
    expect(pattern).toMatch(/\/\*$/);
    const parent = path.join(ROOT, pattern.slice(0, -2));
    if (!fs.existsSync(parent)) continue;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(parent, entry.name);
      if (fs.existsSync(path.join(directory, "package.json"))) {
        directories.push(directory);
      }
    }
  }
  return directories.sort();
}

describe("workspace gate coverage", () => {
  it("keeps every workspace in the root build, lint, and test gates", () => {
    const rootManifest = readManifest(ROOT);
    const workspaces = rootManifest.workspaces ?? [];
    const workspaceDirectories = resolveWorkspaceDirectories(workspaces);

    expect(workspaces).toEqual(["packages/*", "apps/*"]);
    expect(workspaceDirectories.length).toBeGreaterThan(0);
    expect(rootManifest.scripts?.build).toContain("npm run build:workspaces");
    expect(rootManifest.scripts?.["build:workspaces"]).toContain(
      "tsc -b packages/*",
    );
    expect(rootManifest.scripts?.watch).toContain("npm run build:workspaces");
    expect(rootManifest.scripts?.lint).toContain("npm run lint:workspaces");
    expect(rootManifest.scripts?.test).toContain("npm run test:workspaces");

    for (const directory of workspaceDirectories) {
      const relativeDirectory = path.relative(ROOT, directory);
      const manifest = readManifest(directory);
      expect(manifest.name, relativeDirectory).toMatch(/^@agentlink\//);
      expect(manifest.version, relativeDirectory).toMatch(/^0\./);
      expect(manifest.private, relativeDirectory).toBe(true);
      expect(manifest.scripts?.build, relativeDirectory).toBeTruthy();
      expect(manifest.scripts?.lint, relativeDirectory).toBeTruthy();
      expect(manifest.scripts?.test, relativeDirectory).toBeTruthy();
      expect(
        fs.existsSync(path.join(directory, "tsconfig.json")),
        relativeDirectory,
      ).toBe(true);
      expect(
        rootManifest.dependencies?.[manifest.name!],
        relativeDirectory,
      ).toBe(manifest.version);
      if (relativeDirectory.startsWith("packages/")) {
        expect(
          rootManifest.scripts?.["build:workspaces"],
          relativeDirectory,
        ).toContain("packages/*");
      } else {
        expect(
          rootManifest.scripts?.["build:workspaces"],
          relativeDirectory,
        ).toContain(relativeDirectory);
      }
    }
  });
});
