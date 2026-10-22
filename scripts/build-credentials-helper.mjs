import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSigningPolicy, signMacBinary } from "./macos-signing.mjs";

import childProcess from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Every copy shares this identifier, so one Keychain approval covers them all. */
export const CREDENTIALS_HELPER_IDENTIFIER = "com.agentlink.credentials";

export const CREDENTIALS_HELPER_SOURCE = path.join(
  repoRoot,
  "packages/node-host/native/credentials-helper/main.swift",
);

/**
 * File name for a surface's copy. macOS names the program in its Keychain
 * prompt, so the name says which surface is asking.
 */
export function credentialsHelperName(surface) {
  return `AgentLink Credentials (${surface})`;
}

/**
 * Compile and sign the shared Keychain helper. Returns undefined when signing
 * is disabled (AGENTLINK_MAC_SIGNING=unsigned): an unsigned helper would get
 * its own Keychain approvals, so surfaces fall back to direct access instead.
 */
export async function buildCredentialsHelper({
  outputPath,
  policy = resolveSigningPolicy(),
  arch = process.arch,
}) {
  if (process.platform !== "darwin") {
    throw new Error("The AgentLink Credentials helper builds on macOS only.");
  }
  if (policy.mode !== "development") return undefined;
  const target = arch === "x64" ? "x86_64" : "arm64";
  await mkdir(path.dirname(outputPath), { recursive: true });
  childProcess.execFileSync(
    "xcrun",
    [
      "swiftc",
      "-O",
      "-target",
      `${target}-apple-macos12.0`,
      "-framework",
      "Security",
      CREDENTIALS_HELPER_SOURCE,
      "-o",
      outputPath,
    ],
    { stdio: "pipe" },
  );
  signMacBinary(outputPath, {
    identity: policy.identity,
    identifier: CREDENTIALS_HELPER_IDENTIFIER,
  });
  return outputPath;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [outputPath] = process.argv.slice(2);
  if (!outputPath) {
    throw new Error(
      "Usage: node scripts/build-credentials-helper.mjs <output>",
    );
  }
  const built = await buildCredentialsHelper({ outputPath });
  console.log(built ?? "Signing disabled; helper not built.");
}
