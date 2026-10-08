import { mkdir, copyFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => arg.startsWith("--"))) {
  console.error("Usage: node install.mjs [Meridian-plugin-directory]");
  process.exit(1);
}
const pluginDir = resolve(
  args[0] ??
    process.env.MERIDIAN_PLUGIN_DIR ??
    join(homedir(), ".config", "meridian", "plugins"),
);
const source = join(dirname(fileURLToPath(import.meta.url)), "index.js");
const target = join(pluginDir, "agentlink-client-tools.js");
await mkdir(pluginDir, { recursive: true });
const temporary = `${target}.${process.pid}.tmp`;
await copyFile(source, temporary);
await rename(temporary, target);
console.log(`Installed ${target}`);
console.log(
  "Reload Meridian plugins, then start a fresh AgentLink conversation.",
);
