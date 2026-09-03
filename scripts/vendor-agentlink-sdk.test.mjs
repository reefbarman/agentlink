import {
  contentAddressedFilename,
  mergeRequiredPeerDependencies,
  parseArguments,
  selectSupersededArtifactFilenames,
  validatePackageSet,
} from "./vendor-agentlink-sdk.mjs";

import assert from "node:assert/strict";
import test from "node:test";

const digest = "a".repeat(64);

function packageSet() {
  return [
    {
      name: "@agentlink/protocol",
      version: "0.1.0",
      dependencies: {},
    },
    {
      name: "@agentlink/core",
      version: "0.1.0",
      dependencies: { "@agentlink/protocol": "0.1.0" },
    },
    {
      name: "@agentlink/node-host",
      version: "0.1.0",
      dependencies: {
        "@agentlink/core": "0.1.0",
        "@agentlink/protocol": "0.1.0",
      },
    },
  ];
}

test("parses a required destination and explicit options", () => {
  const options = parseArguments([
    "--destination",
    "vendor/agentlink",
    "--include-node-host",
    "--prune",
    "--skip-verify",
  ]);
  assert.equal(options.destination.endsWith("vendor/agentlink"), true);
  assert.equal(options.includeNodeHost, true);
  assert.equal(options.prune, true);
  assert.equal(options.verify, false);
  assert.throws(() => parseArguments([]), /--destination is required/);
  assert.throws(() => parseArguments(["--unknown"]), /Unknown argument/);
});

test("creates content-addressed package filenames", () => {
  assert.equal(
    contentAddressedFilename("@agentlink/core", "0.1.0", digest),
    `agentlink-core-0.1.0-${digest}.tgz`,
  );
  assert.throws(
    () => contentAddressedFilename("other/core", "0.1.0", digest),
    /Invalid package name/,
  );
  assert.throws(
    () => contentAddressedFilename("@agentlink/core", "latest", digest),
    /Invalid package version/,
  );
});

test("selects only safe superseded artifacts named by the previous manifest", () => {
  const oldCore = `agentlink-core-0.1.0-${"b".repeat(64)}.tgz`;
  const currentCore = `agentlink-core-0.1.0-${"c".repeat(64)}.tgz`;
  const oldProtocol = `agentlink-protocol-0.1.0-${"d".repeat(64)}.tgz`;
  assert.deepEqual(
    selectSupersededArtifactFilenames(
      {
        packages: [
          { filename: oldProtocol },
          { filename: oldCore },
          { filename: currentCore },
        ],
      },
      [{ filename: currentCore }],
    ),
    [oldCore, oldProtocol],
  );
  assert.deepEqual(selectSupersededArtifactFilenames(undefined, []), []);
  assert.throws(
    () =>
      selectSupersededArtifactFilenames(
        { packages: [{ filename: "../outside.tgz" }] },
        [],
      ),
    /unsafe artifact filename/,
  );
  assert.throws(
    () => selectSupersededArtifactFilenames({ packages: "invalid" }, []),
    /invalid previous SDK manifest/,
  );
  assert.deepEqual(
    selectSupersededArtifactFilenames(
      { packages: [], pendingPrune: [oldCore] },
      [],
    ),
    [oldCore],
  );
});

test("merges compatible required peers and rejects conflicts", () => {
  assert.deepEqual(
    mergeRequiredPeerDependencies([
      { peerDependencies: { zod: "^4.0.0" } },
      { peerDependencies: { zod: "^4.0.0", react: "^19.0.0" } },
    ]),
    { zod: "^4.0.0", react: "^19.0.0" },
  );
  assert.throws(
    () =>
      mergeRequiredPeerDependencies([
        { peerDependencies: { zod: "^4.0.0" } },
        { peerDependencies: { zod: "^3.25.0" } },
      ]),
    /Conflicting required peer dependency zod/,
  );
});

test("requires exact paired and transitive AgentLink package versions", () => {
  assert.doesNotThrow(() =>
    validatePackageSet(packageSet().slice(0, 2), false),
  );
  assert.doesNotThrow(() => validatePackageSet(packageSet(), true));
  assert.throws(
    () =>
      validatePackageSet(
        packageSet().map((entry) =>
          entry.name === "@agentlink/core"
            ? {
                ...entry,
                dependencies: { "@agentlink/protocol": "0.2.0" },
              }
            : entry,
        ),
        false,
      ),
    /exact vendored protocol version/,
  );
  assert.throws(
    () => validatePackageSet(packageSet().slice(0, 2), true),
    /requires node-host/,
  );
});
