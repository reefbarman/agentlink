import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.join(REPOSITORY_ROOT, "src");

type FirstRootPattern =
  | "workspaceFolderIndex"
  | "tryGetFirstWorkspaceRoot"
  | "getProjectConfigForFirstRoot"
  | "getFirstWorkspaceRoot"
  | "firstExistingRootResolution";

type InventoryEntry = {
  counts: Partial<Record<FirstRootPattern, number>>;
  classification:
    | "session_or_target_project_bug"
    | "workspace_level_order_sensitive"
    | "compatibility_only"
    | "telemetry_attribution"
    | "mixed";
  ownerSlices: Array<"B" | "C" | "E" | "G" | "H" | "J">;
  rationale: string;
};

const PATTERNS: Record<FirstRootPattern, RegExp> = {
  workspaceFolderIndex: /workspaceFolders\s*(?:\?\.)?\s*\[\s*0\s*\]/g,
  tryGetFirstWorkspaceRoot: /tryGetFirstWorkspaceRoot/g,
  getProjectConfigForFirstRoot: /getProjectConfigForFirstRoot/g,
  getFirstWorkspaceRoot: /\bgetFirstWorkspaceRoot\b/g,
  firstExistingRootResolution: /resolveRelativeToWorkspace/g,
};

/**
 * Slice A baseline. Every production occurrence is intentionally listed here so
 * later slices can remove entries as their project-aware replacement lands.
 * Tests and mocks are excluded from the scan and are not part of this inventory.
 */
const ALLOWLIST: Record<string, InventoryEntry> = {
  "src/adapters/vscode/languageCapabilities.ts": {
    counts: { workspaceFolderIndex: 1, tryGetFirstWorkspaceRoot: 2 },
    classification: "compatibility_only",
    ownerSlices: ["G"],
    rationale:
      "Legacy provider fallbacks remain for direct tests/projectless callers; agent runtimes pass a project root and execute inside the request-bound workspace scope.",
  },
  "src/adapters/vscode/readSearchCapabilities.ts": {
    counts: { tryGetFirstWorkspaceRoot: 3 },
    classification: "compatibility_only",
    ownerSlices: ["G"],
    rationale:
      "Legacy provider fallbacks remain for direct callers; agent runtimes execute them inside the request-bound workspace scope.",
  },

  "src/extension.ts": {
    counts: { workspaceFolderIndex: 2 },
    classification: "mixed",
    ownerSlices: ["B", "C", "J"],
    rationale:
      "Worktree intent is a narrow compatibility path; browser/window identity needs deterministic workspace ownership.",
  },
  "src/services/semanticSearch.ts": {
    counts: { tryGetFirstWorkspaceRoot: 3 },
    classification: "compatibility_only",
    ownerSlices: ["G"],
    rationale:
      "Semantic fallback retains direct-call compatibility while request-scoped runtimes pin all workspace helpers to the session project.",
  },
  "src/tools/executeCommand.ts": {
    counts: { tryGetFirstWorkspaceRoot: 2 },
    classification: "compatibility_only",
    ownerSlices: ["G", "H"],
    rationale:
      "The first-root fallback is retained for direct legacy callers; request-scoped runtimes expose every declared workspace root and commands honor their explicit cwd.",
  },
  "src/tools/findAndReplace.ts": {
    counts: { tryGetFirstWorkspaceRoot: 2 },
    classification: "compatibility_only",
    ownerSlices: ["G"],
    rationale:
      "The direct-call fallback remains compatible while agent runtime search and mutation roots are pinned by async-local session scope.",
  },
  "src/tools/proposeMemory.ts": {
    counts: { tryGetFirstWorkspaceRoot: 2 },
    classification: "compatibility_only",
    ownerSlices: ["G", "H"],
    rationale:
      "Direct callers retain the legacy fallback; agent runtime project proposals resolve through the request-bound project root.",
  },
  "src/tools/readFile.ts": {
    counts: { tryGetFirstWorkspaceRoot: 3 },
    classification: "compatibility_only",
    ownerSlices: ["G"],
    rationale:
      "Direct callers retain legacy path suggestions; agent runtime reads execute inside the request-bound project scope.",
  },
  "src/util/paths.ts": {
    counts: {
      tryGetFirstWorkspaceRoot: 1,
      getFirstWorkspaceRoot: 1,
      firstExistingRootResolution: 2,
    },
    classification: "compatibility_only",
    ownerSlices: ["G"],
    rationale:
      "Legacy helpers remain as compatibility APIs but use async-local request roots when invoked by project-bound agent runtimes.",
  },
};

describe("project scope first-root source contract", () => {
  it("keeps every production first-root occurrence explicitly classified", () => {
    const actual = collectInventory();
    const expected = Object.fromEntries(
      Object.entries(ALLOWLIST).map(([filePath, entry]) => [
        filePath,
        normalizeCounts(entry.counts),
      ]),
    );

    expect(actual).toEqual(expected);
    expect(
      Object.values(ALLOWLIST).every(
        (entry) =>
          entry.ownerSlices.length > 0 && entry.rationale.trim().length > 0,
      ),
    ).toBe(true);
  });

  it("tracks the remaining audited first-root inventory", () => {
    const counts = Object.values(collectInventory()).flatMap((entry) =>
      Object.values(entry),
    );

    expect(Object.keys(ALLOWLIST)).toHaveLength(9);
    expect(counts.reduce((total, count) => total + count, 0)).toBe(24);
  });
});

function collectInventory(): Record<string, Record<FirstRootPattern, number>> {
  const inventory: Record<string, Record<FirstRootPattern, number>> = {};
  for (const filePath of walkProductionTypeScriptFiles(SOURCE_ROOT)) {
    const source = fs.readFileSync(filePath, "utf8");
    const counts = normalizeCounts(
      Object.fromEntries(
        Object.entries(PATTERNS).map(([name, pattern]) => [
          name,
          source.match(pattern)?.length ?? 0,
        ]),
      ) as Record<FirstRootPattern, number>,
    );
    if (Object.keys(counts).length === 0) continue;
    inventory[toRepositoryPath(filePath)] = counts;
  }
  return Object.fromEntries(
    Object.entries(inventory).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function normalizeCounts(
  counts: Partial<Record<FirstRootPattern, number>>,
): Record<FirstRootPattern, number> {
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([, count]) => count !== undefined && count > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<FirstRootPattern, number>;
}

function walkProductionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__mocks__") continue;
      files.push(...walkProductionTypeScriptFiles(filePath));
      continue;
    }
    if (
      entry.isFile() &&
      (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) &&
      !filePath.endsWith(".d.ts") &&
      !filePath.endsWith(".test.ts") &&
      !filePath.endsWith(".test.tsx")
    ) {
      files.push(filePath);
    }
  }
  return files;
}

function toRepositoryPath(filePath: string): string {
  return path.relative(REPOSITORY_ROOT, filePath).split(path.sep).join("/");
}
