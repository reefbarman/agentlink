import {
  ASSISTANT_DEPLOYMENT_ASSETS,
  writeAssistantDeploymentMetadata,
} from "./assistant-deployment-assets.mjs";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function fixture(t) {
  const out = mkdtempSync(path.join(os.tmpdir(), "assistant-assets-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  for (const name of ASSISTANT_DEPLOYMENT_ASSETS)
    writeFileSync(path.join(out, name), `asset ${name}\n`);
  return { out, version: "1.2.3", commit: "a".repeat(40) };
}

test("hashes canonical flat deployment assets only, never installed config or credentials", (t) => {
  const options = fixture(t);
  for (const name of [
    "server.json",
    ".env",
    "secrets",
    "assistant-release.env",
    "searxng.settings.example.yml",
  ]) {
    writeFileSync(path.join(options.out, name), "private");
  }
  const result = writeAssistantDeploymentMetadata(options);
  assert.deepEqual(Object.keys(result.assets), ASSISTANT_DEPLOYMENT_ASSETS);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.updaterProtocol, 1);
  assert.match(result.assets["compose.update-client.yaml"], /^[0-9a-f]{64}$/);
  assert.equal(
    result.assets["upgrade.sh"],
    createHash("sha256").update("asset upgrade.sh\n").digest("hex"),
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(path.join(options.out, "assistant-deployment.json")),
    ),
    result,
  );
});

test("rejects unknown compose templates, missing required assets and symlinks", (t) => {
  const options = fixture(t);
  const unknown = path.join(options.out, "compose.custom.yaml");
  writeFileSync(unknown, "services: {}");
  assert.throws(() => writeAssistantDeploymentMetadata(options), /Unknown/);
  rmSync(unknown);
  const script = path.join(options.out, "install.sh");
  rmSync(script);
  assert.throws(() => writeAssistantDeploymentMetadata(options), /Missing/);
  symlinkSync(path.join(options.out, "upgrade.sh"), script);
  assert.throws(() => writeAssistantDeploymentMetadata(options), /regular/);
});

test("rejects invalid release identity", (t) => {
  const options = fixture(t);
  for (const patch of [
    { version: "v1.2.3" },
    { version: "1.2.3/evil" },
    { commit: "main" },
  ]) {
    assert.throws(
      () => writeAssistantDeploymentMetadata({ ...options, ...patch }),
      /Invalid/,
    );
  }
});
