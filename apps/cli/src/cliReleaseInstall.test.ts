import { describe, expect, it, vi } from "vitest";
import {
  installCliReleaseUpdate,
  recognizeCliPreviewLayout,
  validateArchiveListing,
  verifyCliUpdateBundle,
} from "./cliReleaseInstall.js";
import {
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const download = vi.hoisted(() => vi.fn());
vi.mock("../../../src/updates/releaseInstall.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/updates/releaseInstall.js")
  >()),
  downloadReleaseUpdate: download,
}));

describe("CLI release installer verification", () => {
  it("accepts a forward-compatible manifest and verifies the complete inventory", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agentlink-update-test-"),
    );
    try {
      const files = {
        "bin/agentlink": "launcher",
        "node/bin/node": "node binary",
        "dist/agentlink.js": "cli entry",
        "dist/new-runtime-module.js": "future runtime module",
      };
      for (const [name, contents] of Object.entries(files)) {
        const filename = path.join(root, name);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, contents);
      }
      const hashes = Object.fromEntries(
        Object.entries(files).map(([name, contents]) => [
          name,
          createHash("sha256").update(contents).digest("hex"),
        ]),
      );
      await writeFile(
        path.join(root, "bundle-manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          platform: "darwin-arm64",
          version: "1.2.3",
          signing: "unsigned",
          node: { version: "24.1.0" },
          files: hashes,
        }),
      );
      await expect(
        verifyCliUpdateBundle(root, "1.2.3"),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown schemas, inventory drift, and hash mismatches", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agentlink-update-test-"),
    );
    try {
      for (const name of [
        "bin/agentlink",
        "node/bin/node",
        "dist/agentlink.js",
      ]) {
        const filename = path.join(root, name);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, name);
      }
      const files = Object.fromEntries(
        ["bin/agentlink", "node/bin/node", "dist/agentlink.js"].map((name) => [
          name,
          createHash("sha256").update(name).digest("hex"),
        ]),
      );
      const manifestPath = path.join(root, "bundle-manifest.json");
      const manifest = {
        schemaVersion: 1,
        platform: "darwin-arm64",
        version: "1.2.3",
        signing: "unsigned",
        files,
      };
      await writeFile(
        manifestPath,
        JSON.stringify({ ...manifest, schemaVersion: 2 }),
      );
      await expect(verifyCliUpdateBundle(root, "1.2.3")).rejects.toThrow(
        "Unknown CLI bundle manifest version",
      );
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(path.join(root, "unexpected.txt"), "extra");
      await expect(verifyCliUpdateBundle(root, "1.2.3")).rejects.toThrow(
        "inventory",
      );
      await rm(path.join(root, "unexpected.txt"));
      await writeFile(path.join(root, "bin/agentlink"), "tampered");
      await expect(verifyCliUpdateBundle(root, "1.2.3")).rejects.toThrow(
        "SHA-256 mismatch",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin" && process.arch === "arm64")(
    "recognizes only the supported preview install layout and launcher",
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "agentlink-home-"));
      try {
        const bundle = path.join(
          home,
          ".local/lib/agentlink/cli-preview.test/agentlink-cli-darwin-arm64",
        );
        const executable = path.join(bundle, "node/bin/node");
        const launcher = path.join(home, ".local/bin/agentlink");
        await mkdir(path.dirname(executable), { recursive: true });
        await mkdir(path.dirname(launcher), { recursive: true });
        await writeFile(executable, "node");
        await mkdir(path.join(bundle, "bin"), { recursive: true });
        await writeFile(path.join(bundle, "bin/agentlink"), "launcher");
        await symlink(path.join(bundle, "bin/agentlink"), launcher);
        await expect(
          recognizeCliPreviewLayout(executable, home),
        ).resolves.toMatchObject({
          bundleRoot: await realpath(bundle),
          launcher: path.join(
            await realpath(path.dirname(launcher)),
            "agentlink",
          ),
        });
        const alias = path.join(home, "home-alias");
        await symlink(home, alias);
        await expect(
          recognizeCliPreviewLayout(await realpath(executable), alias),
        ).resolves.toMatchObject({ bundleRoot: await realpath(bundle) });
        const relocatedLibrary = path.join(home, "relocated-library");
        await rename(path.join(home, ".local/lib/agentlink"), relocatedLibrary);
        await symlink(
          relocatedLibrary,
          path.join(home, ".local/lib/agentlink"),
        );
        await expect(
          recognizeCliPreviewLayout(await realpath(executable), home),
        ).resolves.toMatchObject({
          libraryRoot: await realpath(relocatedLibrary),
        });
        await expect(
          recognizeCliPreviewLayout(
            path.join(
              home,
              ".local/lib/agentlink/cli/agentlink-cli-darwin-arm64/node/bin/node",
            ),
            home,
          ),
        ).rejects.toThrow("unsigned CLI preview installs");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it
    .runIf(process.platform === "darwin" && process.arch === "arm64")
    .each([true, false])(
    "activates only a verified CLI and retains the old bundle (valid=%s)",
    async (valid) => {
      const home = await mkdtemp(path.join(os.tmpdir(), "cli-install-"));
      try {
        const oldBundle = path.join(
          home,
          ".local/lib/agentlink/cli-preview.old/agentlink-cli-darwin-arm64",
        );
        const executable = path.join(oldBundle, "node/bin/node");
        const launcher = path.join(home, ".local/bin/agentlink");
        await mkdir(path.dirname(executable), { recursive: true });
        await writeFile(executable, "old node");
        await mkdir(path.join(oldBundle, "bin"));
        await writeFile(path.join(oldBundle, "bin/agentlink"), "old launcher");
        await mkdir(path.dirname(launcher), { recursive: true });
        await symlink(path.join(oldBundle, "bin/agentlink"), launcher);
        const source = path.join(home, "source/agentlink-cli-darwin-arm64");
        const files = {
          "bin/agentlink": "#!/bin/sh\nprintf '1.2.3\\n'\n",
          "node/bin/node": "new node",
          "dist/agentlink.js": "new cli",
        };
        for (const [name, contents] of Object.entries(files)) {
          await mkdir(path.dirname(path.join(source, name)), {
            recursive: true,
          });
          await writeFile(path.join(source, name), contents, { mode: 0o755 });
        }
        await writeFile(
          path.join(source, "bundle-manifest.json"),
          JSON.stringify({
            schemaVersion: 1,
            platform: "darwin-arm64",
            version: "1.2.3",
            signing: "unsigned",
            files: Object.fromEntries(
              Object.entries(files).map(([name, contents]) => [
                name,
                createHash("sha256").update(contents).digest("hex"),
              ]),
            ),
          }),
        );
        if (!valid)
          await writeFile(path.join(source, "dist/agentlink.js"), "tampered");
        const archive = path.join(home, "new.tar.gz");
        execFileSync("/usr/bin/tar", [
          "-czf",
          archive,
          "-C",
          path.dirname(source),
          path.basename(source),
        ]);
        download.mockResolvedValueOnce(archive);
        const identity = {
          product: "cli" as const,
          version: "1.0.0",
          target: "darwin-arm64",
          development: false,
        };
        const candidate = {
          version: "1.2.3",
          tag: "cli-v1.2.3",
          channel: "preview" as const,
          target: "darwin-arm64",
          releaseUrl: "",
          instructionsUrl: "",
        };
        const operation = installCliReleaseUpdate(identity, candidate, {
          home,
          executablePath: executable,
        });
        if (valid) {
          await operation;
          expect(await readlink(launcher)).not.toBe(
            path.join(oldBundle, "bin/agentlink"),
          );
          expect(
            execFileSync(launcher, ["--version"], { encoding: "utf8" }).trim(),
          ).toBe("1.2.3");
        } else {
          await expect(operation).rejects.toThrow("SHA-256 mismatch");
          expect(await readlink(launcher)).toBe(
            path.join(oldBundle, "bin/agentlink"),
          );
        }
        expect(await realpath(executable)).toBeTruthy();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("rejects traversal paths and archive links before extraction", () => {
    expect(() =>
      validateArchiveListing(
        ["agentlink-cli-darwin-arm64/../escape"],
        ["-rw-r--r-- 0/0 1 Jan 1 00:00 agentlink-cli-darwin-arm64/../escape"],
      ),
    ).toThrow("Unsafe CLI update archive entry");
    expect(() =>
      validateArchiveListing(
        ["agentlink-cli-darwin-arm64/link"],
        [
          "lrwxr-xr-x 0/0 1 Jan 1 00:00 agentlink-cli-darwin-arm64/link -> /tmp/target",
        ],
      ),
    ).toThrow("Unsafe CLI update archive entry");
    expect(() =>
      validateArchiveListing(
        ["agentlink-cli-darwin-arm64/file"],
        ["-rw-r--r-- 0/0 1 Jan 1 00:00 agentlink-cli-darwin-arm64/file"],
      ),
    ).not.toThrow();
  });
});
