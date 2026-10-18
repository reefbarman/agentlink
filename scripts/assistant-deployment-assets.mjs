import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

import { createHash } from "node:crypto";
import path from "node:path";

// Flat release filenames only. Config, credentials and .env are never assets.
export const ASSISTANT_DEPLOYMENT_ASSETS = [
  "install.sh",
  "upgrade.sh",
  "compose.yaml",
  "compose.backup.yaml",
  "compose.browser.yaml",
  "compose.editor.yaml",
  "compose.meridian.yaml",
  "compose.publisher.yaml",
  "compose.runners.yaml",
  "compose.searxng.yaml",
  "compose.worker-egress.yaml",
  "compose.witness.yaml",
  "compose.updater.yaml",
  "compose.update-client.yaml",
  "server.example.json",
];

/** Call after copying release assets, before publishing the release directory. */
export function writeAssistantDeploymentMetadata({ out, version, commit }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Invalid Assistant deployment version");
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("Invalid Assistant deployment commit");
  }
  const names = readdirSync(out);
  for (const name of names) {
    if (
      name.startsWith("compose") &&
      name.endsWith(".yaml") &&
      !ASSISTANT_DEPLOYMENT_ASSETS.includes(name)
    ) {
      throw new Error(`Unknown Assistant deployment template: ${name}`);
    }
  }
  const assets = {};
  for (const name of ASSISTANT_DEPLOYMENT_ASSETS) {
    if (!names.includes(name)) {
      if (["install.sh", "upgrade.sh", "compose.yaml"].includes(name)) {
        throw new Error(`Missing Assistant deployment asset: ${name}`);
      }
      continue;
    }
    const file = path.join(out, name);
    if (!lstatSync(file).isFile())
      throw new Error(`Not a regular asset: ${name}`);
    assets[name] = createHash("sha256")
      .update(readFileSync(file))
      .digest("hex");
  }
  const metadata = {
    schemaVersion: 1,
    updaterProtocol: 1,
    // The release's installer and updater share the deployment lifecycle
    // guard (UPDATER/.deployment-mutation-lock and .lifecycle-state.json).
    // Installer capability and uninstall commands require it.
    lifecycleProtocol: 1,
    version,
    commit,
    assets,
  };
  writeFileSync(
    path.join(out, "assistant-deployment.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  return metadata;
}
