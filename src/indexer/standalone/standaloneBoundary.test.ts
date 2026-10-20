import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The standalone index ships in the CLI and Assistant bundles, so neither it
 * nor anything it imports from root `src` may reach VS Code or LanceDB.
 */
describe("standalone structural index boundary", () => {
  it("imports nothing that reaches vscode or LanceDB", () => {
    const root = path.resolve(__dirname, "../..");
    const visited = new Set<string>();
    const forbidden: string[] = [];
    const pending = [
      path.join(__dirname, "StandaloneStructuralIndex.ts"),
      path.join(__dirname, "structuralIndexTools.ts"),
    ];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /^\s*(?:import|export)[^"']*?from\s+["']([^"']+)["']/gmu,
      )) {
        const specifier = match[1]!;
        if (/^(?:vscode|@lancedb\/|apache-arrow)/u.test(specifier)) {
          forbidden.push(`${path.relative(root, file)} -> ${specifier}`);
        }
        if (!specifier.startsWith(".")) continue;
        const resolved = path
          .resolve(path.dirname(file), specifier)
          .replace(/\.js$/u, ".ts");
        if (fs.existsSync(resolved)) pending.push(resolved);
      }
    }
    expect(forbidden).toEqual([]);
    expect(visited.size).toBeGreaterThan(5);
  });
});
