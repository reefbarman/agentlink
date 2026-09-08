#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check")) {
  throw new Error("Usage: node scripts/generate-tool-inventory.mjs [--check]");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env };
delete env.AGENTLINK_UPDATE_TOOL_INVENTORY;
if (!args.includes("--check")) env.AGENTLINK_UPDATE_TOOL_INVENTORY = "1";
const result = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "src/agent/toolInventory.test.ts"],
  { cwd: root, env, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (result.status === 0 && !args.includes("--check")) {
  const formatted = spawnSync(
    process.execPath,
    ["node_modules/oxfmt/bin/oxfmt", "scripts/tool-inventory.json"],
    { cwd: root, env, stdio: "inherit" },
  );
  if (formatted.error) throw formatted.error;
  process.exitCode = formatted.status ?? 1;
}
