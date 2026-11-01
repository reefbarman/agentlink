import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  connect,
  makeArrowTable,
  prewarmLanceDbNativeModule,
} from "./lanceDbRuntime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("LanceDB runtime loader", () => {
  it("loads the addon on first connect, after a warm-up that may fail", async () => {
    expect(() => makeArrowTable([{ id: 1 }])).toThrow(
      /before a connection was opened/,
    );

    const logs: string[] = [];
    await expect(
      prewarmLanceDbNativeModule({
        moduleDirectory: process.cwd(),
        nodeExecutable: path.join(os.tmpdir(), "agentlink-missing-node"),
        log: (message) => logs.push(message),
      }),
    ).resolves.toBeUndefined();
    expect(logs).toEqual([
      expect.stringMatching(/^\[lancedb\] native warm-up failed/),
    ]);

    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-lancedb-runtime-"),
    );
    roots.push(root);
    const connection = await connect(root);
    try {
      const table = await connection.createTable(
        "rows",
        makeArrowTable([{ id: 1 }, { id: 2 }]),
      );
      await expect(table.countRows()).resolves.toBe(2);
      table.close();
    } finally {
      connection.close();
    }
  });
});
