import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

import { fileURLToPath } from "node:url";
import path from "node:path";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const IMPORT_SPECIFIER =
  /(?:^|\n)\s*(?:import|export)\s[^"']*?from\s+["']([^"']+)["']/gu;
const ALLOWED_PACKAGES = new Set([
  "@agentlink/node-host",
  "@agentlink/protocol",
  "picomatch",
  "vitest",
]);

function sourceFiles(): string[] {
  return readdirSync(SOURCE_ROOT).filter((name) => name.endsWith(".ts"));
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

describe("@agentlink/sandbox package boundary", () => {
  it("imports only sibling modules, Node built-ins, and declared packages", () => {
    const violations: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(path.join(SOURCE_ROOT, file), "utf8");
      for (const match of source.matchAll(IMPORT_SPECIFIER)) {
        const specifier = match[1]!;
        if (specifier.startsWith("node:")) continue;
        if (specifier.startsWith("./") && !specifier.includes("/../")) continue;
        if (ALLOWED_PACKAGES.has(packageName(specifier))) continue;
        violations.push(`${file}: ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
