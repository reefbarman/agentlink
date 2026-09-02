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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "node-host-write-"));
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "node-host-write-"));
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "node-host-write-outside-"),
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
      "path_not_granted",
    );
    await assertError(
      { path: "relative.txt", content: "after", expectedAbsent: true },
      "absolute_path_required",
    );
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("secret");
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("allows deliberate creation only under a directory grant and preserves exact file grants", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "node-host-write-"));
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

  it("applies canonical unique SEARCH/REPLACE blocks only to a hash-pinned grant", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "node-host-diff-"));
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
        operation: "modified",
        blocksApplied: 1,
        contentHash: hash("alpha\nBETA\ngamma"),
      }),
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe(
      "alpha\nBETA\ngamma",
    );
    await fs.rm(root, { recursive: true, force: true });
  });

  it("fails closed and leaves the file untouched for malformed, ambiguous, missing, or stale patches", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "node-host-diff-"));
    const target = path.join(root, "record.txt");
    const original = "repeat\nneedle\nrepeat";
    await fs.writeFile(target, original, "utf8");
    const resolver = createNodeHostApplyDiffTools({
      resolveGrants: () => [{ rootPath: root, kind: "directory" }],
    });
    const apply = await applyDiffTool(resolver);
    const assertError = async (
      patch: string,
      expectedContentHash: string,
      code: string,
    ) => {
      await expect(
        apply.execute(
          { path: target, diff: patch, expectedContentHash },
          context(),
        ),
      ).resolves.toMatchObject({
        isError: true,
        modelContent: JSON.stringify({ error: code }),
      });
      await expect(fs.readFile(target, "utf8")).resolves.toBe(original);
    };

    await assertError(
      diff("repeat", "changed"),
      hash(original),
      "search_ambiguous",
    );
    await assertError(
      diff("missing", "changed"),
      hash(original),
      "search_not_found",
    );
    await assertError(
      "@@ -1 +1 @@\n-old\n+new",
      hash(original),
      "invalid_diff",
    );
    await assertError(
      diff("needle", "changed"),
      hash("stale"),
      "content_hash_mismatch",
    );
    await assertError(
      `${diff("needle", "changed")}\nnot-a-block`,
      hash(original),
      "invalid_diff",
    );
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not partially apply a later failing block", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "node-host-diff-"));
    const target = path.join(root, "record.txt");
    const original = "first\nsecond";
    await fs.writeFile(target, original, "utf8");
    const resolver = createNodeHostApplyDiffTools({
      resolveGrants: () => [{ rootPath: root, kind: "directory" }],
    });
    const apply = await applyDiffTool(resolver);
    const patch = `${diff("first", "FIRST")}\n${diff("missing", "changed")}`;

    await expect(
      apply.execute(
        { path: target, diff: patch, expectedContentHash: hash(original) },
        context(),
      ),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({ error: "search_not_found" }),
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe(original);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("delegates a hash-pinned granted change set to the host transaction and returns its commit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "node-host-multi-"));
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
      transactionId: "tx-1",
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("fails before prepare for invalid change sets and surfaces durable recovery IDs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "node-host-multi-"));
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "node-host-multi-outside-"),
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "node-host-write-"));
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
