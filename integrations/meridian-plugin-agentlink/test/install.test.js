import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("installation replaces this plugin and preserves unrelated plugins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentlink-plugin-install-"));
  try {
    const unrelated = join(dir, "other-plugin.js");
    const target = join(dir, "agentlink-client-tools.js");
    await writeFile(unrelated, "existing plugin");
    await writeFile(target, "older AgentLink version");
    execFileSync(process.execPath, [
      fileURLToPath(new URL("../install.mjs", import.meta.url)),
      dir,
    ]);
    assert.equal(await readFile(unrelated, "utf8"), "existing plugin");
    assert.equal(
      await readFile(target, "utf8"),
      await readFile(new URL("../index.js", import.meta.url), "utf8"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
