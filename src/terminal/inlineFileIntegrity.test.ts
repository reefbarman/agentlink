import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { verifyTerminalInlineFiles } from "./inlineFileIntegrity.js";

const roots: string[] = [];

async function fixture(content = "approved bytes\n") {
  const createdRoot = await mkdtemp(
    path.join(os.tmpdir(), "al-inline-integrity-"),
  );
  roots.push(createdRoot);
  const root = await realpath(createdRoot);
  const filePath = path.join(root, "input.txt");
  await writeFile(filePath, content);
  return {
    root,
    filePath,
    descriptor: {
      name: "input",
      path: filePath,
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("verifyTerminalInlineFiles", () => {
  it("returns the approved binding and canonical path", async () => {
    const test = await fixture();

    await expect(
      verifyTerminalInlineFiles([test.descriptor], {
        requireCanonicalPaths: true,
      }),
    ).resolves.toEqual({
      binding: [
        {
          name: "input",
          bytes: test.descriptor.bytes,
          sha256: test.descriptor.sha256,
        },
      ],
      canonicalPaths: [test.filePath],
    });
  });

  it("rejects bytes changed after materialization", async () => {
    const test = await fixture();
    await writeFile(test.filePath, "changed bytes\n");

    await expect(
      verifyTerminalInlineFiles([test.descriptor], {
        requireCanonicalPaths: true,
      }),
    ).rejects.toThrow("Inline file changed after materialization: input");
  });

  it("rejects a deleted inline file", async () => {
    const test = await fixture();
    await rm(test.filePath);

    await expect(
      verifyTerminalInlineFiles([test.descriptor], {
        requireCanonicalPaths: true,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["directory", "symlink"])(
    "rejects replacement with a %s",
    async (replacement) => {
      const test = await fixture();
      await rm(test.filePath);
      if (replacement === "directory") {
        await mkdir(test.filePath);
      } else {
        const target = path.join(test.root, "target.txt");
        await writeFile(target, "approved bytes\n");
        await symlink(target, test.filePath);
      }

      await expect(
        verifyTerminalInlineFiles([test.descriptor], {
          requireCanonicalPaths: true,
        }),
      ).rejects.toThrow("regular non-symlink file");
    },
  );
});
