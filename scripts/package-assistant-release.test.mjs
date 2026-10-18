import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { packageAssistantRelease } from "./package-assistant-release.mjs";
import path from "node:path";
import test from "node:test";

const targets = [
  "assistant",
  "command-worker",
  "publisher",
  "backup",
  "editor",
  "browser",
  "updater",
];
const digests = Object.fromEntries(
  targets.map((target, index) => [
    target,
    `sha256:${String(index + 1).repeat(64)}`,
  ]),
);

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "assistant-release-test-"));
  const container = path.join(root, "apps/server/deploy/container");
  mkdirSync(path.join(container, "witness"), { recursive: true });
  for (const file of [
    "compose.yaml",
    "compose.runners.yaml",
    "server.example.json",
    "searxng.settings.example.yml",
    "witness/compose.yaml",
  ]) {
    writeFileSync(path.join(container, file), file);
  }
  for (const file of ["install.sh", "upgrade.sh"]) {
    writeFileSync(path.join(root, "apps/server/deploy", file), file);
  }
  return root;
}

test("writes strict digest-pinned manifest and individual deployment release assets", async () => {
  const root = fixture();
  try {
    const output = await packageAssistantRelease({
      version: "0.2.3",
      commit: "a".repeat(40),
      digests,
      out: "release-assets",
      root,
    });
    const manifest = readFileSync(
      path.join(output, "assistant-release.env"),
      "utf8",
    );
    assert.match(manifest, /^RELEASE_VERSION=0\.2\.3\nRELEASE_COMMIT=a{40}\n/m);
    for (const target of targets) {
      const image =
        target === "command-worker"
          ? "agentlink-command-worker"
          : `agentlink-${target}`;
      assert.ok(
        manifest.includes(
          `${target.replaceAll("-", "_").toUpperCase()}_IMAGE=ghcr.io/reefbarman/${image}@${digests[target]}`,
        ),
      );
    }
    assert.deepEqual(readdirSync(output).sort(), [
      "agentlink-update.json",
      "assistant-deployment.json",
      "assistant-release.env",
      "compose.runners.yaml",
      "compose.witness.yaml",
      "compose.yaml",
      "install.sh",
      "searxng.settings.example.yml",
      "server.example.json",
      "upgrade.sh",
    ]);
    const update = JSON.parse(
      readFileSync(path.join(output, "agentlink-update.json"), "utf8"),
    );
    assert.deepEqual(update, {
      schemaVersion: 1,
      product: "assistant",
      version: "0.2.3",
      tag: "assistant-v0.2.3",
      channel: "preview",
      targets: {
        "linux-x64": "assistant-release.env",
        "linux-arm64": "assistant-release.env",
      },
      engines: {},
    });
    const deployment = JSON.parse(
      readFileSync(path.join(output, "assistant-deployment.json"), "utf8"),
    );
    assert.equal(deployment.version, "0.2.3");
    assert.equal(deployment.commit, "a".repeat(40));
    assert.equal(deployment.updaterProtocol, 1);
    assert.equal(deployment.lifecycleProtocol, 1);
    assert.match(deployment.assets["compose.yaml"], /^[0-9a-f]{64}$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("supports explicit stable discovery metadata", () => {
  const root = fixture();
  try {
    const output = packageAssistantRelease({
      version: "1.2.3",
      commit: "b".repeat(40),
      digests,
      out: "release-assets",
      root,
      channel: "stable",
    });
    const metadata = JSON.parse(
      readFileSync(path.join(output, "agentlink-update.json"), "utf8"),
    );
    assert.equal(metadata.channel, "stable");
    assert.equal(metadata.tag, "assistant-v1.2.3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builds architecture-specific editor images from the shared verified server bundle", () => {
  const workflow = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../.github/workflows/assistant-release.yml",
    ),
    "utf8",
  );
  assert.match(
    workflow,
    /AGENTLINK_BUILD_COMMIT: \$\{\{ steps\.source\.outputs\.commit \}\}/u,
  );
  assert.match(
    workflow,
    /name: Verify shared bundle identity[\s\S]*?agentlink-server\.js[\s\S]*?slice\(0, 12\)/u,
  );
  assert.match(
    workflow,
    /name: assistant-server-bundle[\s\S]*?path: apps\/server\/dist\/agentlink-server\.js/u,
  );
  assert.match(
    workflow,
    /target: linux-x64[\s\S]*?runner: ubuntu-latest[\s\S]*?target: linux-arm64[\s\S]*?runner: ubuntu-24\.04-arm/u,
  );
  assert.match(
    workflow,
    /AGENTLINK_VSCE_TARGET: \$\{\{ matrix\.target \}\}[\s\S]*?npm run package -- "apps\/server\/dist\/agentlink-editor-/u,
  );
  assert.match(
    workflow,
    /name: assistant-editor-\$\{\{ matrix\.target \}\}[\s\S]*?agentlink-editor-\$\{\{ matrix\.target \}\}\.vsix/u,
  );
  assert.match(
    workflow,
    /name: assistant-server-bundle[\s\S]*?path: apps\/server\/dist[\s\S]*?name: assistant-editor-linux-/u,
  );
  assert.match(workflow, /platforms: .*matrix\.platform/u);
  assert.match(
    workflow,
    /mv "apps\/server\/dist\/agentlink-editor-linux-\$\{EDITOR_TARGET\}\.vsix" apps\/server\/dist\/agentlink-editor\.vsix/u,
  );
  assert.match(workflow, /notes --unit assistant/u);
  // Managed updates replace templates with images; notes must not say otherwise.
  assert.doesNotMatch(workflow, /changes images only/u);
  assert.match(workflow, /images and management templates together/u);
  assert.match(workflow, /--notes-file notes\.md/u);
  assert.match(workflow, /name: assistant-editor-linux-/u);
  assert.match(
    workflow,
    /docker buildx imagetools create[\s\S]*?\$tag-amd64@\$amd64[\s\S]*?\$tag-arm64@\$arm64/u,
  );
  assert.match(
    workflow,
    /if: inputs\.publish && github\.repository == 'reefbarman\/agentlink' && github\.ref == 'refs\/heads\/main'/u,
  );
  assert.match(workflow, /default: false/u);
  assert.match(workflow, /git rev-parse HEAD/u);
  assert.ok(
    workflow.includes("RELEASE_COMMIT: ${{ needs.verify.outputs.commit }}"),
  );
  const publisher = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "release-publish.mjs",
    ),
    "utf8",
  );
  assert.match(workflow, /node scripts\/release-publish\.mjs/u);
  assert.match(
    publisher,
    /"create"[\s\S]*?"--target"[\s\S]*?"--title"[\s\S]*?"--notes-file"/u,
  );
  assert.doesNotMatch(workflow, /vsce@[^\n]+package --no-dependencies/u);
  assert.doesNotMatch(
    workflow,
    /scripts\/release-publish\.mjs[\s\\\S]*?--notes-file[^\n]*\n[^\n]*missing/u,
  );
});

test("rejects malformed version, commit, missing/extra target and malformed digest", () => {
  const root = fixture();
  const base = {
    version: "0.2.3",
    commit: "b".repeat(40),
    digests,
    out: "release-assets",
    root,
  };
  try {
    for (const [override, pattern] of [
      [{ version: "v0.2.3" }, /version/u],
      [{ version: "01.2.3" }, /version/u],
      [{ version: "0.2.3-rc.1" }, /version/u],
      [{ version: "9007199254740992.2.3" }, /version/u],
      [{ channel: "nightly" }, /channel/u],
      [{ commit: "b".repeat(39) }, /commit/u],
      [{ digests: { ...digests, browser: undefined } }, /browser/u],
      [
        {
          digests: Object.fromEntries(
            Object.entries(digests).filter(([key]) => key !== "updater"),
          ),
        },
        /exactly/u,
      ],
      [{ digests: { ...digests, updater: "latest" } }, /updater/u],
      [
        { digests: { ...digests, extra: `sha256:${"a".repeat(64)}` } },
        /exactly/u,
      ],
      [{ digests: { ...digests, editor: "sha256:ABC" } }, /editor/u],
    ]) {
      assert.throws(
        () => packageAssistantRelease({ ...base, ...override }),
        pattern,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
