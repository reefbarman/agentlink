import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  measureDirectoryBytes,
  measureReclaimedBytes,
} from "./storeDiskUsage.js";

let root: string;

function write(relativePath: string, bytes: number): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(bytes));
  return filePath;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "store-disk-usage-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("measureDirectoryBytes", () => {
  it("sums regular files in nested directories", async () => {
    write("table.lance/_versions/1.manifest", 100);
    write("table.lance/data/a.lance", 250);
    write("top.json", 7);

    await expect(measureDirectoryBytes(root)).resolves.toBe(357);
  });

  it("does not follow symlinks", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "store-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "big"), Buffer.alloc(1_000));
      fs.symlinkSync(outside, path.join(root, "linked-dir"));
      fs.symlinkSync(path.join(outside, "big"), path.join(root, "linked"));
      write("real", 10);

      await expect(measureDirectoryBytes(root)).resolves.toBe(10);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("measures a missing directory as zero", async () => {
    await expect(
      measureDirectoryBytes(path.join(root, "missing")),
    ).resolves.toBe(0);
  });
});

describe("measureReclaimedBytes", () => {
  it("reports how much the directory shrank, including old version files", async () => {
    const manifests = Array.from({ length: 5 }, (_, index) =>
      write(`chunks.lance/_versions/${index}.manifest`, 1_000),
    );
    write("chunks.lance/data/current.lance", 500);

    const result = await measureReclaimedBytes(root, async () => {
      for (const manifest of manifests.slice(0, 4)) fs.rmSync(manifest);
    });

    expect(result).toEqual({ bytesReclaimed: 4_000, bytesAfter: 1_500 });
  });

  it("reports zero when the operation grows the directory", async () => {
    write("chunks.lance/data/a.lance", 100);

    const result = await measureReclaimedBytes(root, async () => {
      write("chunks.lance/data/compacted.lance", 300);
    });

    expect(result).toEqual({ bytesReclaimed: 0, bytesAfter: 400 });
  });

  it("propagates operation failures", async () => {
    await expect(
      measureReclaimedBytes(root, async () => {
        throw new Error("optimize failed");
      }),
    ).rejects.toThrow("optimize failed");
  });
});
