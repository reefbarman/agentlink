import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getManagedTypeScriptStatus,
  installManagedTypeScriptLanguageServer,
  removeManagedTypeScriptLanguageServer,
  type ManagedTypeScriptPackageRecipe,
  type ManagedTypeScriptRecipe,
} from "./managedTypeScriptInstaller.js";

const roots: string[] = [];

function tarArchive(files: Readonly<Record<string, string>>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content);
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, `package/${name}`);
    writeTarString(header, 100, 8, "0000600\0");
    writeTarString(header, 108, 8, "0000000\0");
    writeTarString(header, 116, 8, "0000000\0");
    writeTarString(
      header,
      124,
      12,
      `${bytes.length.toString(8).padStart(11, "0")}\0`,
    );
    writeTarString(header, 136, 12, "00000000000\0");
    header.fill(32, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeTarString(header, 257, 6, "ustar\0");
    writeTarString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarString(
      header,
      148,
      8,
      `${checksum.toString(8).padStart(6, "0")}\0 `,
    );
    blocks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function writeTarString(
  buffer: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  buffer.write(
    value,
    offset,
    Math.min(length, Buffer.byteLength(value)),
    "ascii",
  );
}

function packageArchive(
  name: ManagedTypeScriptPackageRecipe["name"],
  version: string,
  extra: Readonly<Record<string, string>>,
  scripts?: Readonly<Record<string, string>>,
  dependencies?: Readonly<Record<string, string>>,
): Buffer {
  return tarArchive({
    "package.json": JSON.stringify({
      name,
      version,
      license: "Apache-2.0",
      ...(scripts ? { scripts } : {}),
      ...(dependencies ? { dependencies } : {}),
    }),
    LICENSE: `${name} test license\n`,
    ...extra,
  });
}

function recipeFor(
  languageServer: Buffer,
  typescript: Buffer,
): ManagedTypeScriptRecipe {
  const packageRecipe = (
    name: ManagedTypeScriptPackageRecipe["name"],
    version: string,
    archive: Buffer,
  ): ManagedTypeScriptPackageRecipe => ({
    name,
    version,
    url: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
  });
  return {
    id: "test-recipe",
    languageServer: packageRecipe(
      "typescript-language-server",
      "1.0.0",
      languageServer,
    ),
    typescript: packageRecipe("typescript", "2.0.0", typescript),
  };
}

async function fixture() {
  const dataRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "managed-typescript-installer-"),
  );
  roots.push(dataRoot);
  const languageServer = packageArchive("typescript-language-server", "1.0.0", {
    "lib/cli.mjs": "console.log('fixture');\n",
  });
  const typescript = packageArchive("typescript", "2.0.0", {
    "lib/tsserver.js": "// fixture\n",
    "ThirdPartyNoticeText.txt": "fixture notice\n",
  });
  const recipe = recipeFor(languageServer, typescript);
  const archives = new Map([
    [recipe.languageServer.url, languageServer],
    [recipe.typescript.url, typescript],
  ]);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const archive = archives.get(String(url));
    return archive
      ? new Response(new Uint8Array(archive), {
          status: 200,
          headers: { "content-length": String(archive.length) },
        })
      : new Response(null, { status: 404 });
  });
  return { dataRoot, recipe, fetch, languageServer, typescript };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("managed TypeScript installer", () => {
  it("installs the exact package closure, verifies it, and removes it", async () => {
    const test = await fixture();
    const installed = await installManagedTypeScriptLanguageServer({
      dataRoot: test.dataRoot,
      recipe: test.recipe,
      fetch: test.fetch,
    });

    expect(installed).toMatchObject({
      state: "ready",
      recipe: { id: "test-recipe" },
      licenses: [
        "node_modules/typescript-language-server/LICENSE",
        "node_modules/typescript/LICENSE",
        "node_modules/typescript/ThirdPartyNoticeText.txt",
      ],
    });
    expect(test.fetch).toHaveBeenCalledTimes(2);
    if (installed.state !== "ready") throw new Error("Expected ready status");
    await fs.appendFile(installed.tsserverPath, "// tampered\n");
    await expect(
      getManagedTypeScriptStatus(test.dataRoot, test.recipe),
    ).resolves.toMatchObject({
      state: "corrupt",
      reason: "package_tree_mismatch:typescript",
    });
    await expect(
      removeManagedTypeScriptLanguageServer(test.dataRoot),
    ).resolves.toBe(true);
    await expect(
      getManagedTypeScriptStatus(test.dataRoot, test.recipe),
    ).resolves.toMatchObject({ state: "unavailable" });
  });

  it("recovers a lock left by a definitely dead local process", async () => {
    const test = await fixture();
    const lockRoot = path.join(test.dataRoot, "language-servers", "typescript");
    await fs.mkdir(lockRoot, { recursive: true });
    await fs.writeFile(
      path.join(lockRoot, ".operation.lock"),
      `${JSON.stringify({
        nonce: "dead-lock",
        pid: 2_147_483_647,
        hostname: os.hostname(),
      })}\n`,
    );

    await expect(
      installManagedTypeScriptLanguageServer({
        dataRoot: test.dataRoot,
        recipe: test.recipe,
        fetch: test.fetch,
      }),
    ).resolves.toMatchObject({ state: "ready" });
  });

  it("rejects integrity failures without publishing a partial installation", async () => {
    const test = await fixture();
    const corruptRecipe: ManagedTypeScriptRecipe = {
      ...test.recipe,
      languageServer: {
        ...test.recipe.languageServer,
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      },
    };

    await expect(
      installManagedTypeScriptLanguageServer({
        dataRoot: test.dataRoot,
        recipe: corruptRecipe,
        fetch: test.fetch,
      }),
    ).rejects.toThrow("archive_integrity_mismatch");
    await expect(
      getManagedTypeScriptStatus(test.dataRoot, corruptRecipe),
    ).resolves.toMatchObject({ state: "unavailable" });
  });

  it("rejects undeclared runtime dependencies before publication", async () => {
    const test = await fixture();
    const dependent = packageArchive(
      "typescript-language-server",
      "1.0.0",
      { "lib/cli.mjs": "console.log('fixture');\n" },
      undefined,
      { unexpected: "1.0.0" },
    );
    const recipe = recipeFor(dependent, test.typescript);
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (url) =>
        new Response(
          new Uint8Array(
            String(url) === recipe.languageServer.url
              ? dependent
              : test.typescript,
          ),
          { status: 200 },
        ),
    );

    await expect(
      installManagedTypeScriptLanguageServer({
        dataRoot: test.dataRoot,
        recipe,
        fetch,
      }),
    ).rejects.toThrow(
      "unexpected_runtime_dependency:typescript-language-server",
    );
  });

  it("rejects package install scripts before publication", async () => {
    const test = await fixture();
    const scripted = packageArchive(
      "typescript-language-server",
      "1.0.0",
      { "lib/cli.mjs": "console.log('fixture');\n" },
      { postinstall: "node exploit.js" },
    );
    const recipe = recipeFor(scripted, test.typescript);
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (url) =>
        new Response(
          new Uint8Array(
            String(url) === recipe.languageServer.url
              ? scripted
              : test.typescript,
          ),
          { status: 200 },
        ),
    );

    await expect(
      installManagedTypeScriptLanguageServer({
        dataRoot: test.dataRoot,
        recipe,
        fetch,
      }),
    ).rejects.toThrow(
      "forbidden_lifecycle_script:typescript-language-server:postinstall",
    );
    await expect(
      getManagedTypeScriptStatus(test.dataRoot, recipe),
    ).resolves.toMatchObject({ state: "unavailable" });
  });
});
