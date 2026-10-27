import { describe, expect, it, vi } from "vitest";

import { createHash } from "node:crypto";
import {
  createNodeHostApplyDiffTools,
  createNodeHostMultiFileWriteTools,
  createNodeHostWriteTools,
  type ResolveNodeHostWriteGrantsRequest,
} from "./writeTools.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function context(overrides = {}) {
  return {
    principal,
    sessionId: "session-a",
    turnId: "turn-a",
    model: {
      model: { providerId: "fixture", modelId: "fixture-model" },
      source: "runtime" as const,
    },
    signal: undefined,
    ...overrides,
  };
}

async function writeTool(
  resolver: ReturnType<typeof createNodeHostWriteTools>,
) {
  const tools = await resolver({
    principal,
    sessionId: "session-a",
    turnId: "turn-a",
    input: { text: "test", attachments: undefined },
  });
  const tool = tools.find(
    (candidate) => candidate.definition.name === "write_file",
  );
  if (!tool) throw new Error("Missing write_file tool");
  return tool;
}

async function applyDiffTool(
  resolver: ReturnType<typeof createNodeHostApplyDiffTools>,
) {
  const tools = await resolver({
    principal,
    sessionId: "session-a",
    turnId: "turn-a",
    input: { text: "test", attachments: undefined },
  });
  const tool = tools.find(
    (candidate) => candidate.definition.name === "apply_diff",
  );
  if (!tool) throw new Error("Missing apply_diff tool");
  return tool;
}

async function multiFileTool(
  resolver: ReturnType<typeof createNodeHostMultiFileWriteTools>,
) {
  const tools = await resolver({
    principal,
    sessionId: "session-a",
    turnId: "turn-a",
    input: { text: "test", attachments: undefined },
  });
  const tool = tools.find(
    (candidate) => candidate.definition.name === "apply_multi_file",
  );
  if (!tool) throw new Error("Missing apply_multi_file tool");
  return tool;
}

function diff(search: string, replace: string): string {
  return [
    "<<<<<<< SEARCH",
    search,
    "======= DIVIDER =======",
    replace,
    ">>>>>>> REPLACE",
  ].join("\n");
}

describe("node host write tools", () => {
  it("requires core authorization metadata and atomically replaces only a hash-pinned granted file", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "node-host-write-"),
    );
    const target = path.join(root, "record.txt");
    await fs.writeFile(target, "before", "utf8");
    const resolver = createNodeHostWriteTools({
      resolveGrants: () => [{ rootPath: root, kind: "directory" }],
    });
    const write = await writeTool(resolver);

    expect(write).toMatchObject({
      effect: "write",
      authorization: "required",
      definition: { name: "write_file" },
    });
    await expect(
      write.execute(
        { path: target, content: "after", expectedContentHash: hash("before") },
        context(),
      ),
    ).resolves.toMatchObject({
      modelContent: expect.stringContaining('"operation":"modified"'),
      displayContent: expect.objectContaining({
        operation: "modified",
        contentHash: hash("after"),
      }),
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("after");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("fails closed for absent/mismatched preconditions, ungranted targets, symlink escapes, and implicit paths", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "node-host-write-"),
    );
    const outside = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "node-host-write-outside-"),
    );
    const target = path.join(root, "record.txt");
    const escaped = path.join(root, "escaped.txt");
    const outsideFile = path.join(outside, "secret.txt");
    await fs.writeFile(target, "before", "utf8");
    await fs.writeFile(outsideFile, "secret", "utf8");
    await fs.symlink(outsideFile, escaped);
    const resolver = createNodeHostWriteTools({
      resolveGrants: () => [{ rootPath: root, kind: "directory" }],
    });
    const write = await writeTool(resolver);
    const assertError = async (
      input: Record<string, unknown>,
      code: string,
    ) => {
      await expect(write.execute(input, context())).resolves.toMatchObject({
        isError: true,
        modelContent: JSON.stringify({ error: code }),
      });
    };

    await assertError(
      { path: target, content: "after", expectedAbsent: true },
      "expected_file_absent",
    );
    await assertError(
      { path: target, content: "after", expectedContentHash: hash("stale") },
      "content_hash_mismatch",
    );
    await assertError(
      {
        path: path.join(root, "new.txt"),
        content: "new",
        expectedContentHash: hash(""),
      },
      "expected_file_missing",
    );
    await assertError(
      {
        path: outsideFile,
        content: "after",
        expectedContentHash: hash("secret"),
      },
      "path_not_granted",
    );
    await assertError(
      { path: escaped, content: "after", expectedContentHash: hash("secret") },
      "path_alias",
    );
    await assertError(
      { path: "relative.txt", content: "after", expectedAbsent: true },
      "absolute_path_required",
    );
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("secret");
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("reclaims only definitely dead same-host write locks", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "node-host-write-lock-"),
    );
    const target = path.join(root, "record.txt");
    const lockPath = path.join(root, ".record.txt.agentlink-write.lock");
    await fs.writeFile(target, "before", "utf8");
    const write = await writeTool(
      createNodeHostWriteTools({
        resolveGrants: () => [{ rootPath: root, kind: "directory" }],
      }),
    );
    const input = {
      path: target,
      content: "after",
      expectedContentHash: hash("before"),
    };

    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        version: 1,
        ownerNonce: "dead-owner",
        hostname: os.hostname(),
        pid: 2_147_483_647,
      })}\n`,
      { mode: 0o600 },
    );
    await expect(write.execute(input, context())).resolves.toMatchObject({
      displayContent: expect.objectContaining({ contentHash: hash("after") }),
    });
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    await fs.writeFile(target, "before", "utf8");
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        version: 1,
        ownerNonce: "live-owner",
        hostname: os.hostname(),
        pid: process.pid,
      })}\n`,
      { mode: 0o600 },
    );
    await expect(write.execute(input, context())).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({ error: "write_locked" }),
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("before");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("allows deliberate creation only under a directory grant and preserves exact file grants", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "node-host-write-"),
    );
    const existing = path.join(root, "existing.txt");
    const created = path.join(root, "created.txt");
    await fs.writeFile(existing, "before", "utf8");
    const directoryResolver = createNodeHostWriteTools({
      resolveGrants: () => [{ rootPath: root, kind: "directory" }],
    });
    const directoryWrite = await writeTool(directoryResolver);

    await expect(
      directoryWrite.execute(
        { path: created, content: "created", expectedAbsent: true },
        context(),
      ),
    ).resolves.toMatchObject({
      displayContent: expect.objectContaining({ operation: "created" }),
    });
    await expect(fs.readFile(created, "utf8")).resolves.toBe("created");

    const fileResolver = createNodeHostWriteTools({
      resolveGrants: () => [{ rootPath: existing, kind: "file" }],
    });
    const fileWrite = await writeTool(fileResolver);
    await expect(
      fileWrite.execute(
        { path: created, content: "blocked", expectedAbsent: true },
        context(),
      ),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({ error: "path_not_granted" }),
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("applies unique SEARCH/REPLACE blocks only to a hash-pinned grant", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "node-host-diff-"),
    );
    const target = path.join(root, "record.txt");
    await fs.writeFile(target, "alpha\nbeta\ngamma", "utf8");
    const resolver = createNodeHostApplyDiffTools({
      resolveGrants: () => [{ rootPath: root, kind: "directory" }],
    });
    const apply = await applyDiffTool(resolver);

    expect(apply).toMatchObject({
      effect: "write",
      authorization: "required",
      definition: { name: "apply_diff" },
    });
    await expect(
      apply.execute(
        {
          path: target,
          diff: diff("beta", "BETA"),
          expectedContentHash: hash("alpha\nbeta\ngamma"),
        },
        context(),
      ),
    ).resolves.toMatchObject({
      displayContent: expect.objectContaining({
        status: "accepted",
        operation: "modified",
        contentHash: hash("alpha\nBETA\ngamma"),
        post_edit_content_hash: hash("alpha\nBETA\ngamma"),
      }),
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe(
      "alpha\nBETA\ngamma",
    );
    await fs.rm(root, { recursive: true, force: true });
  });

  it("accepts VS Code block_options, unified hunks, and requires the hash unless host-prepared", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "node-host-diff-"),
    );
    const target = path.join(root, "record.txt");
    await fs.writeFile(target, "repeat\nmid\nrepeat", "utf8");
    const resolver = createNodeHostApplyDiffTools({
      resolveGrants: () => [{ rootPath: root, kind: "directory" }],
    });
    const apply = await applyDiffTool(resolver);
    expect(apply.definition.input_schema).toMatchObject({
      required: ["path", "diff", "expectedContentHash"],
    });

    await apply.execute(
      {
        path: target,
        diff: diff("repeat", "R2"),
        block_options: [{ index: 0, occurrence: 2 }],
        expectedContentHash: hash("repeat\nmid\nrepeat"),
      },
      context(),
    );
    await expect(fs.readFile(target, "utf8")).resolves.toBe("repeat\nmid\nR2");

    await apply.execute(
      {
        path: target,
        diff: "@@ -1,2 +1,2 @@\n repeat\n-mid\n+MID",
        expectedContentHash: hash("repeat\nmid\nR2"),
      },
      context(),
    );
    await expect(fs.readFile(target, "utf8")).resolves.toBe("repeat\nMID\nR2");

    const prepared = await applyDiffTool(
      createNodeHostApplyDiffTools({
        resolveGrants: () => [{ rootPath: root, kind: "directory" }],
        contentHashInput: "host_prepared",
      }),
    );
    expect(prepared.definition.input_schema).toMatchObject({
      required: ["path", "diff"],
    });
    // Execution still refuses an unpinned write.
    await expect(
      prepared.execute({ path: target, diff: diff("MID", "x") }, context()),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({ error: "expected_content_hash_required" }),
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("fails closed and leaves the file untouched for ambiguous, missing, or stale patches", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "node-host-diff-"),
    );
    const target = path.join(root, "record.txt");
    const original = "repeat\nneedle\nrepeat";
    await fs.writeFile(target, original, "utf8");
    const resolver = createNodeHostApplyDiffTools({
      resolveGrants: () => [{ rootPath: root, kind: "directory" }],
    });
    const apply = await applyDiffTool(resolver);
    const failure = async (patch: string, expectedContentHash: string) => {
      const result = await apply.execute(
        { path: target, diff: patch, expectedContentHash },
        context(),
      );
      expect(result.isError).toBe(true);
      await expect(fs.readFile(target, "utf8")).resolves.toBe(original);
      return JSON.parse(String(result.modelContent)) as Record<string, any>;
    };

    const ambiguous = await failure(diff("repeat", "changed"), hash(original));
    expect(ambiguous).toMatchObject({
      error: "All search/replace blocks failed",
      failed_block_details: [
        expect.objectContaining({
          reason: "ambiguous_exact",
          retry_options: expect.objectContaining({
            replace_all_example: { index: 0, replace_all: true },
          }),
        }),
      ],
    });
    expect(
      (await failure(diff("missing", "changed"), hash(original)))
        .failed_block_details[0],
    ).toMatchObject({ reason: "not_found" });
    expect(
      (await failure("@@ -1 +1 @@\n-old\n+new", hash(original))).error,
    ).toBe("All search/replace blocks failed");
    expect(await failure(diff("needle", "changed"), hash("stale"))).toEqual({
      error: "content_hash_mismatch",
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports VS Code partial results, and atomic=true applies nothing on a later failing block", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "node-host-diff-"),
    );
    const target = path.join(root, "record.txt");
    const original = "first\nsecond";
    await fs.writeFile(target, original, "utf8");
    const resolver = createNodeHostApplyDiffTools({
      resolveGrants: () => [{ rootPath: root, kind: "directory" }],
    });
    const apply = await applyDiffTool(resolver);
    const patch = `${diff("first", "FIRST")}\n${diff("missing", "changed")}`;

    const atomic = await apply.execute(
      {
        path: target,
        diff: patch,
        atomic: true,
        expectedContentHash: hash(original),
      },
      context(),
    );
    expect(atomic.isError).toBe(true);
    expect(JSON.parse(String(atomic.modelContent))).toMatchObject({
      error: "Atomic apply_diff validation failed",
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe(original);

    const partial = await apply.execute(
      { path: target, diff: patch, expectedContentHash: hash(original) },
      context(),
    );
    expect(JSON.parse(String(partial.modelContent))).toMatchObject({
      status: "accepted",
      partial: true,
      failed_blocks: [1],
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("FIRST\nsecond");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("delegates a hash-pinned granted change set to the host transaction and returns its commit", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "node-host-multi-"),
    );
    const first = path.join(root, "first.txt");
    const second = path.join(root, "second.txt");
    await fs.writeFile(first, "one", "utf8");
    await fs.writeFile(second, "two", "utf8");
    const prepare = vi.fn(async () => ({
      ok: true as const,
      transactionId: "tx-1",
    }));
    const commit = vi.fn(async () => ({
      ok: true as const,
      status: "committed" as const,
    }));
    const recover = vi.fn();
    const resolver = createNodeHostMultiFileWriteTools({
      resolveGrants: () => [{ rootPath: root, kind: "directory" }],
      transactions: { prepare, commit, recover },
    });
    const multi = await multiFileTool(resolver);

    expect(multi).toMatchObject({
      effect: "write",
      authorization: "required",
      definition: { name: "apply_multi_file" },
    });
    await expect(
      multi.execute(
        {
          changes: [
            { path: first, expectedContentHash: hash("one"), content: "ONE" },
            { path: second, expectedContentHash: hash("two"), content: "TWO" },
          ],
        },
        context(),
      ),
    ).resolves.toMatchObject({
      displayContent: { transactionId: "tx-1", status: "committed", files: 2 },
    });
    expect(prepare).toHaveBeenCalledWith({
      principal,
      sessionId: "session-a",
      turnId: "turn-a",
      input: { text: "test", attachments: undefined },
      changes: [
        {
          path: await fs.realpath(first),
          expectedContentHash: hash("one"),
          content: "ONE",
        },
        {
          path: await fs.realpath(second),
          expectedContentHash: hash("two"),
          content: "TWO",
        },
      ],
    });
    expect(commit).toHaveBeenCalledWith({
      principal,
      sessionId: "session-a",
      turnId: "turn-a",
      input: { text: "test", attachments: undefined },
      transactionId: "tx-1",
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("fails before prepare for invalid change sets and surfaces durable recovery IDs", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "node-host-multi-"),
    );
    const outside = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "node-host-multi-outside-"),
    );
    const first = path.join(root, "first.txt");
    const outsideFile = path.join(outside, "outside.txt");
    await fs.writeFile(first, "one", "utf8");
    await fs.writeFile(outsideFile, "outside", "utf8");
    const prepare = vi.fn(async () => ({
      ok: true as const,
      transactionId: "tx-2",
    }));
    const commit = vi.fn(async () => ({
      ok: false as const,
      reason: "recovery_required" as const,
      recoveryId: "recovery-2",
    }));
    const resolver = createNodeHostMultiFileWriteTools({
      resolveGrants: () => [{ rootPath: root, kind: "directory" }],
      transactions: { prepare, commit, recover: vi.fn() },
    });
    const multi = await multiFileTool(resolver);

    await expect(
      multi.execute(
        {
          changes: [
            { path: first, expectedContentHash: hash("one"), content: "ONE" },
            {
              path: outsideFile,
              expectedContentHash: hash("outside"),
              content: "OUT",
            },
          ],
        },
        context(),
      ),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({ error: "path_not_granted" }),
    });
    expect(prepare).not.toHaveBeenCalled();
    await expect(
      multi.execute(
        {
          changes: [
            { path: first, expectedContentHash: hash("one"), content: "ONE" },
            { path: first, expectedContentHash: hash("one"), content: "TWO" },
          ],
        },
        context(),
      ),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({ error: "duplicate_change_path" }),
    });
    expect(prepare).not.toHaveBeenCalled();
    await expect(
      multi.execute(
        {
          changes: [
            { path: first, expectedContentHash: hash("one"), content: "ONE" },
          ],
        },
        context(),
      ),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: expect.stringContaining("transaction_recovery_required"),
      displayContent: {
        transactionId: "tx-2",
        recoveryId: "recovery-2",
        isError: true,
      },
    });
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("scopes a resolved writer to its authenticated principal/session/turn", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "node-host-write-"),
    );
    const target = path.join(root, "record.txt");
    await fs.writeFile(target, "before", "utf8");
    const resolveGrants = async ({
      principal: requestPrincipal,
    }: ResolveNodeHostWriteGrantsRequest) =>
      requestPrincipal.subjectId === principal.subjectId
        ? [{ rootPath: root, kind: "directory" as const }]
        : [];
    const resolver = createNodeHostWriteTools({ resolveGrants });
    const write = await writeTool(resolver);

    await expect(
      write.execute(
        { path: target, content: "after", expectedContentHash: hash("before") },
        context({
          principal: { tenantId: "tenant-b", subjectId: "subject-b" },
        }),
      ),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({ error: "write_turn_mismatch" }),
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("before");
    await fs.rm(root, { recursive: true, force: true });
  });
});
