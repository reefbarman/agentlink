import childProcess from "node:child_process";

const IDENTITY_PATTERN =
  /^\s*\d+\)\s+([0-9A-F]{40})\s+"(Apple Development: [^"]+)"\s*$/gimu;

function identities() {
  if (process.platform !== "darwin") {
    throw new Error(
      "Development signing requires macOS; set AGENTLINK_MAC_SIGNING=unsigned for CI previews.",
    );
  }
  const output = childProcess.execFileSync(
    "security",
    ["find-identity", "-v", "-p", "codesigning"],
    {
      encoding: "utf8",
    },
  );
  return [...output.matchAll(IDENTITY_PATTERN)].map((match) => ({
    hash: match[1].toUpperCase(),
    name: match[2],
  }));
}

export function resolveSigningPolicy({
  mode = process.env.AGENTLINK_MAC_SIGNING,
  identity = process.env.AGENTLINK_MAC_SIGNING_IDENTITY,
} = {}) {
  const resolvedMode = mode === undefined ? "development" : mode;
  if (resolvedMode !== "development" && resolvedMode !== "unsigned") {
    throw new Error(
      `Invalid AGENTLINK_MAC_SIGNING mode: ${resolvedMode}. Use development or unsigned.`,
    );
  }
  if (resolvedMode === "unsigned") {
    if (identity)
      throw new Error("An identity cannot be specified in unsigned mode.");
    return { mode: "unsigned" };
  }
  const valid = identities();
  const matches = identity
    ? valid.filter(
        ({ hash, name }) =>
          hash === identity.toUpperCase() || name === identity,
      )
    : valid;
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one valid Apple Development signing identity, found ${matches.length}. ` +
        "Run security find-identity -v -p codesigning and set AGENTLINK_MAC_SIGNING_IDENTITY to its full name or SHA-1 fingerprint.",
    );
  }
  return { mode: "development", identity: matches[0].hash };
}

export function signMacBinary(
  filePath,
  { identity, identifier, entitlements } = {},
) {
  if (!identity || identity === "-" || !identifier) {
    throw new Error(
      "A certificate identity and stable identifier are required to sign a macOS binary.",
    );
  }
  const args = [
    "--force",
    "--sign",
    identity,
    "--identifier",
    identifier,
    "--timestamp=none",
  ];
  if (entitlements) args.push("--entitlements", entitlements);
  args.push(filePath);
  childProcess.execFileSync("codesign", args, { stdio: "pipe" });
  return verifyMacSignature(filePath, { identifier });
}

export function verifyMacSignature(
  filePath,
  { identifier, deep = false } = {},
) {
  const args = ["--verify", "--strict", "--verbose=2"];
  if (deep) args.push("--deep");
  args.push(filePath);
  childProcess.execFileSync("codesign", args, { stdio: "pipe" });
  // codesign --display writes its metadata to stderr.
  const result = childProcess.spawnSync(
    "codesign",
    ["--display", "--verbose=4", filePath],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr || "Cannot read macOS signing metadata.");
  const metadata = `${result.stdout}\n${result.stderr}`;
  const signedIdentifier = /^Identifier=(.+)$/mu.exec(metadata)?.[1];
  const teamId = /^TeamIdentifier=(.+)$/mu.exec(metadata)?.[1];
  const authority = [...metadata.matchAll(/^Authority=(.+)$/gmu)].map(
    (match) => match[1],
  );
  const flags = /^CodeDirectory .* flags=([^\s]+)/mu.exec(metadata)?.[1] ?? "";
  if (
    !signedIdentifier ||
    !teamId ||
    teamId === "not set" ||
    authority.length === 0 ||
    flags.includes("adhoc")
  ) {
    throw new Error(
      `Expected a valid certificate-backed signature for ${filePath}.`,
    );
  }
  if (identifier && signedIdentifier !== identifier) {
    throw new Error(
      `Expected signature identifier ${identifier}, found ${signedIdentifier} for ${filePath}.`,
    );
  }
  return { identifier: signedIdentifier, teamId, authority };
}
