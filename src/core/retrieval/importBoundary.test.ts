import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const RETRIEVAL_DIR = path.resolve(__dirname);
const FORBIDDEN_PATTERNS = [
  { pattern: /\bQdrant\b/i, label: "Qdrant" },
  { pattern: /\bLanceDB\b/i, label: "LanceDB" },
  { pattern: /\bToolResult\b/, label: "surface tool result" },
  { pattern: /\bcollectionName\b/, label: "backend collection identity" },
  { pattern: /\bqdrantUrl\b/, label: "backend URL" },
  { pattern: /\bpointIds?\b/i, label: "backend point identity" },
  { pattern: /\bcachePath\b/, label: "physical cache path" },
  { pattern: /from\s+["']vscode["']/, label: "VS Code" },
  {
    pattern: /from\s+["']@lancedb\/lancedb["']/,
    label: "LanceDB package",
  },
];

describe("core retrieval import boundary", () => {
  it("keeps production contracts independent of storage and product surfaces", () => {
    const violations: string[] = [];
    for (const filePath of productionTypeScriptFiles(RETRIEVAL_DIR)) {
      const source = fs.readFileSync(filePath, "utf-8");
      for (const rule of FORBIDDEN_PATTERNS) {
        if (rule.pattern.test(source)) {
          violations.push(`${path.basename(filePath)}: contains ${rule.label}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

function productionTypeScriptFiles(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry): string[] => {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return productionTypeScriptFiles(filePath);
      if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) {
        return [];
      }
      return [filePath];
    });
}
