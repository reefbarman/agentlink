import {
  resolveSigningPolicy,
  verifyMacSignature,
} from "../../scripts/macos-signing.mjs";

import path from "node:path";
import { readdir } from "node:fs/promises";
import { signAsync } from "@electron/osx-sign";

const APP_ID = "com.agentlink.desktop";

// electron-builder's non-MAS selector does not include Apple Development. This
// hook runs after all files are assembled and before zip/DMG archive creation.
export default async function signDesktop({ appOutDir, packager }) {
  const policy = resolveSigningPolicy();
  if (policy.mode !== "development") {
    throw new Error("Desktop signing hook must only run in development mode.");
  }
  const app = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  const resources = path.join(app, "Contents", "Resources");
  const binaries = await nativeAddons(resources);
  await signAsync({
    app,
    platform: "darwin",
    type: "development",
    identity: policy.identity,
    identityValidation: false, // Already validated against security find-identity.
    preEmbedProvisioningProfile: false,
    preAutoEntitlements: false,
    // signAsync walks Contents recursively, including the native addons in
    // app.asar.unpacked and extraResources. Avoid signing them twice as binaries.
    optionsForFile: () => ({
      entitlements: [],
      hardenedRuntime: false,
      timestamp: "none",
    }),
  });
  verifyMacSignature(app, { identifier: APP_ID, deep: true });
  for (const binary of binaries) verifyMacSignature(binary);
}

async function nativeAddons(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && file.endsWith(".node")) files.push(file);
    }
  }
  await visit(root);
  if (files.length < 2) {
    throw new Error(
      `Expected both Keychain and retrieval native addons in ${root}.`,
    );
  }
  return files;
}
