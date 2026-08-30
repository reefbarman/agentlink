import {
  assertWorkspacePackagesBundled,
  findWorkspacePackageImports,
} from "./workspace-bundle-closure.mjs";

import assert from "node:assert/strict";
import test from "node:test";

test("accepts bundles with workspace packages fully inlined", () => {
  const metafile = {
    outputs: {
      "dist/extension.js": {
        imports: [{ path: "vscode", external: true }],
      },
    },
  };

  assert.deepEqual(findWorkspacePackageImports(metafile), []);
  assert.doesNotThrow(() => assertWorkspacePackagesBundled(metafile));
});

test("rejects workspace package specifiers left in shipped output", () => {
  const metafile = {
    outputs: {
      "dist/extension.js": {
        imports: [
          { path: "@agentlink/core", external: true },
          { path: "@agentlink/protocol/session", external: false },
        ],
      },
    },
  };

  assert.deepEqual(findWorkspacePackageImports(metafile), [
    {
      outputPath: "dist/extension.js",
      importPath: "@agentlink/core",
      external: true,
    },
    {
      outputPath: "dist/extension.js",
      importPath: "@agentlink/protocol/session",
      external: false,
    },
  ]);
  assert.throws(
    () => assertWorkspacePackagesBundled(metafile),
    /must inline @agentlink workspace packages/,
  );
});
