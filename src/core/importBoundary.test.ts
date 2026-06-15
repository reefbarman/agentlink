import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

const CORE_DIR = path.resolve(__dirname);

const FORBIDDEN_IMPORT_PATTERNS = [
  { pattern: /from\s+["']vscode["']/, label: "vscode" },
  { pattern: /import\s+[^;]*["']vscode["']/, label: "vscode" },
  { pattern: /import\(["']vscode["']\)/, label: "vscode" },
  { pattern: /from\s+["'][^"']*\/agent(?:\/|(?:\.js)?["'])/, label: "agent" },
  { pattern: /import\(["'][^"']*\/agent(?:\/|(?:\.js)?["'])/, label: "agent" },
  { pattern: /from\s+["'][^"']*\/server(?:\/|(?:\.js)?["'])/, label: "server" },
  {
    pattern: /import\(["'][^"']*\/server(?:\/|(?:\.js)?["'])/,
    label: "server",
  },
  { pattern: /from\s+["'][^"']*\/agent\/webview\//, label: "agent webview" },
  {
    pattern: /from\s+["'][^"']*\/browser-gateway\/webview\//,
    label: "browser gateway webview",
  },
  { pattern: /from\s+["'][^"']*\/sidebar\//, label: "sidebar" },
  { pattern: /from\s+["'][^"']*\/extension(?:\.js)?["']/, label: "extension" },
  {
    pattern: /from\s+["'][^"']*\/adapters\/vscode\//,
    label: "VS Code adapter",
  },
];

describe("core import boundary", () => {
  it("keeps src/core free of VS Code and UI-surface imports", () => {
    const violations: string[] = [];

    for (const filePath of walkTypeScriptFiles(CORE_DIR)) {
      const rel = path.relative(path.resolve(__dirname, "..", ".."), filePath);
      const source = fs.readFileSync(filePath, "utf-8");
      for (const rule of FORBIDDEN_IMPORT_PATTERNS) {
        if (rule.pattern.test(source)) {
          violations.push(`${rel}: imports ${rule.label}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

function walkTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTypeScriptFiles(fullPath));
    } else if (
      entry.isFile() &&
      fullPath.endsWith(".ts") &&
      !fullPath.endsWith(".d.ts")
    ) {
      files.push(fullPath);
    }
  }
  return files;
}
