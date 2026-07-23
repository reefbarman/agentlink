import {
  ProtectedRootLeaseCoordinator,
  canonicalizeProtectedRoots,
  prepareProtectedRoots,
  revalidateProtectedRoots,
  validateStructurallyProtectedRoots,
} from "./sandbox-protected-roots.mjs";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

async function makeRoot(prefix) {
  return mkdtemp(path.join(tmpdir(), `al-protected-${prefix}-`));
}

test("canonicalizes, sorts, and deduplicates nested protected roots", async () => {
  const fixture = await makeRoot("canonical");
  try {
    const rootA = path.join(fixture, "a");
    const nestedA = path.join(rootA, "nested");
    const rootB = path.join(fixture, "b");
    await Promise.all([
      mkdir(nestedA, { recursive: true }),
      mkdir(rootB, { recursive: true }),
    ]);

    const actual = await canonicalizeProtectedRoots([rootB, nestedA, rootA]);
    const expected = await Promise.all([realpath(rootA), realpath(rootB)]);
    assert.deepEqual(actual, expected.sort());
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("rejects a symbolic-link protected root", async () => {
  const fixture = await makeRoot("root-symlink");
  try {
    const target = path.join(fixture, "target");
    const alias = path.join(fixture, "alias");
    await mkdir(target);
    await symlink(target, alias);

    await assert.rejects(
      canonicalizeProtectedRoots([alias]),
      /protected root must not be a symbolic link/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("rejects symbolic links nested inside a protected tree", async () => {
  const fixture = await makeRoot("nested-symlink");
  try {
    const protectedRoot = path.join(fixture, "protected");
    await mkdir(protectedRoot);
    await writeFile(path.join(fixture, "outside"), "outside");
    await symlink(
      path.join(fixture, "outside"),
      path.join(protectedRoot, "alias"),
    );

    await assert.rejects(
      prepareProtectedRoots([protectedRoot]),
      /protected tree contains a symbolic link/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("fails closed when a protected file has another hard link", async () => {
  const fixture = await makeRoot("hard-link");
  try {
    const protectedRoot = path.join(fixture, "protected");
    const protectedFile = path.join(protectedRoot, "policy.json");
    await mkdir(protectedRoot);
    await writeFile(protectedFile, "original");
    await link(protectedFile, path.join(fixture, "alias.json"));

    await assert.rejects(
      prepareProtectedRoots([protectedRoot]),
      /protected file has unexpected hard-link count 2/,
    );
    assert.equal(await readFile(protectedFile, "utf8"), "original");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("detects protected content mutations during pre-spawn revalidation", async () => {
  const fixture = await makeRoot("mutation");
  try {
    const protectedRoot = path.join(fixture, "protected");
    const protectedFile = path.join(protectedRoot, "policy.json");
    await mkdir(protectedRoot);
    await writeFile(protectedFile, "original");
    const prepared = await prepareProtectedRoots([protectedRoot]);

    await writeFile(protectedFile, "mutated");

    await assert.rejects(revalidateProtectedRoots(prepared), (error) => {
      assert.match(
        error.message,
        /protected root contents changed before spawn: root=.*\/protected path=policy\.json change=modified/,
      );
      assert.doesNotMatch(error.message, /original|mutated/);
      return true;
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("reports structural additions without exposing protected content", async () => {
  const fixture = await makeRoot("addition-diagnostic");
  try {
    const protectedRoot = path.join(fixture, "protected");
    await mkdir(protectedRoot);
    const prepared = await prepareProtectedRoots([protectedRoot]);
    await writeFile(path.join(protectedRoot, "secret.txt"), "sensitive-value");

    await assert.rejects(revalidateProtectedRoots(prepared), (error) => {
      assert.match(
        error.message,
        /root=.*\/protected path=secret\.txt change=added/,
      );
      assert.doesNotMatch(error.message, /sensitive-value/);
      return true;
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("reports structural removals without exposing protected content", async () => {
  const fixture = await makeRoot("removal-diagnostic");
  try {
    const protectedRoot = path.join(fixture, "protected");
    const protectedFile = path.join(protectedRoot, "secret.txt");
    await mkdir(protectedRoot);
    await writeFile(protectedFile, "sensitive-value");
    const prepared = await prepareProtectedRoots([protectedRoot]);
    await rm(protectedFile);

    await assert.rejects(revalidateProtectedRoots(prepared), (error) => {
      assert.match(
        error.message,
        /root=.*\/protected path=secret\.txt change=removed/,
      );
      assert.doesNotMatch(error.message, /sensitive-value/);
      return true;
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("allows volatile history replacement when only stable AgentLink children are protected", async () => {
  const fixture = await makeRoot("agentlink-history");
  try {
    const agentlinkRoot = path.join(fixture, ".agentlink");
    const policyFile = path.join(agentlinkRoot, "policy.json");
    const historyDir = path.join(agentlinkRoot, "history");
    const historyFile = path.join(historyDir, "sessions.json");
    const historyTemp = path.join(historyDir, ".sessions.atomic.tmp");
    await mkdir(historyDir, { recursive: true });
    await writeFile(policyFile, "policy-original");
    await writeFile(historyFile, "[]");
    const prepared = await prepareProtectedRoots([policyFile]);

    await writeFile(historyTemp, '[{"id":"session-1"}]');
    await rename(historyTemp, historyFile);

    await revalidateProtectedRoots(prepared);

    await writeFile(policyFile, "policy-mutated");
    await assert.rejects(
      revalidateProtectedRoots(prepared),
      /protected root contents changed before spawn/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("allows atomic Git ref replacement under structural protection", async () => {
  const fixture = await makeRoot("git-ref-replacement");
  try {
    const gitRoot = path.join(fixture, ".git");
    const refRoot = path.join(gitRoot, "refs", "remotes", "origin");
    const ref = path.join(refRoot, "main");
    const temporaryRef = path.join(refRoot, ".main.lock");
    await mkdir(refRoot, { recursive: true });
    await writeFile(ref, "a".repeat(40));

    await writeFile(temporaryRef, "b".repeat(40));
    await rename(temporaryRef, ref);

    await assert.doesNotReject(validateStructurallyProtectedRoots([gitRoot]));
    assert.equal(await readFile(ref, "utf8"), "b".repeat(40));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("rejects nested symbolic links under structural protection", async () => {
  const fixture = await makeRoot("git-structural-symlink");
  try {
    const gitRoot = path.join(fixture, ".git");
    const refRoot = path.join(gitRoot, "refs", "heads");
    await mkdir(refRoot, { recursive: true });
    await writeFile(path.join(fixture, "outside-ref"), "a".repeat(40));
    await symlink(
      path.join(fixture, "outside-ref"),
      path.join(refRoot, "main"),
    );

    await assert.rejects(
      validateStructurallyProtectedRoots([gitRoot]),
      /structurally protected tree contains a symbolic link/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("rejects hard-linked files under structural protection", async () => {
  const fixture = await makeRoot("git-structural-hard-link");
  try {
    const gitRoot = path.join(fixture, ".git");
    const refRoot = path.join(gitRoot, "refs", "heads");
    const ref = path.join(refRoot, "main");
    await mkdir(refRoot, { recursive: true });
    await writeFile(ref, "a".repeat(40));
    await link(ref, path.join(fixture, "ref-alias"));

    await assert.rejects(
      validateStructurallyProtectedRoots([gitRoot]),
      /structurally protected file has unexpected hard-link count 2/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("detects protected metadata-only mutations during revalidation", async () => {
  const fixture = await makeRoot("metadata-mutation");
  try {
    const protectedRoot = path.join(fixture, "protected");
    const protectedFile = path.join(protectedRoot, "policy.json");
    await mkdir(protectedRoot);
    await writeFile(protectedFile, "original", { mode: 0o600 });
    const prepared = await prepareProtectedRoots([protectedRoot]);

    await chmod(protectedFile, 0o640);

    await assert.rejects(
      revalidateProtectedRoots(prepared),
      /protected root contents changed before spawn/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("detects mutations to protected files above the hash threshold", async () => {
  const fixture = await makeRoot("large-mutation");
  try {
    const protectedRoot = path.join(fixture, "protected");
    const protectedFile = path.join(protectedRoot, "large-policy.bin");
    await mkdir(protectedRoot);
    await writeFile(protectedFile, Buffer.alloc(1024 * 1024 + 1, 0x61));
    const prepared = await prepareProtectedRoots([protectedRoot]);
    assert.equal(prepared.snapshots[0].entries[1].contentHash, undefined);

    await writeFile(protectedFile, Buffer.alloc(1024 * 1024 + 1, 0x62));

    await assert.rejects(
      revalidateProtectedRoots(prepared),
      /protected root contents changed before spawn/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("detects a protected root replaced after preparation", async () => {
  const fixture = await makeRoot("replacement");
  try {
    const protectedRoot = path.join(fixture, "protected");
    const movedRoot = path.join(fixture, "moved");
    await mkdir(protectedRoot);
    await writeFile(path.join(protectedRoot, "policy.json"), "original");
    const prepared = await prepareProtectedRoots([protectedRoot]);

    await rename(protectedRoot, movedRoot);
    await mkdir(protectedRoot);
    await writeFile(path.join(protectedRoot, "policy.json"), "replacement");

    await assert.rejects(
      revalidateProtectedRoots(prepared),
      /protected root contents changed before spawn/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("rejects trusted-host mutations that overlap an active lease", async () => {
  const fixture = await makeRoot("lease-overlap");
  try {
    const protectedRoot = path.join(fixture, "protected");
    await mkdir(protectedRoot);
    const coordinator = new ProtectedRootLeaseCoordinator();
    const lease = await coordinator.acquire([protectedRoot]);
    try {
      await assert.rejects(
        coordinator.runMutation([path.join(protectedRoot, "policy.json")], () =>
          writeFile(path.join(protectedRoot, "policy.json"), "mutated"),
        ),
        /overlaps an active protected root lease/,
      );
      await assert.rejects(access(path.join(protectedRoot, "policy.json")));
    } finally {
      lease.release();
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("rejects a lease while an overlapping trusted-host mutation is active", async () => {
  const fixture = await makeRoot("active-mutation");
  try {
    const protectedRoot = path.join(fixture, "protected");
    await mkdir(protectedRoot);
    const coordinator = new ProtectedRootLeaseCoordinator();
    let signalMutationStarted;
    const mutationStarted = new Promise((resolve) => {
      signalMutationStarted = resolve;
    });
    let finishMutation;
    const mutationGate = new Promise((resolve) => {
      finishMutation = resolve;
    });
    const mutation = coordinator.runMutation([protectedRoot], async () => {
      signalMutationStarted();
      await mutationGate;
    });
    await mutationStarted;

    await assert.rejects(
      coordinator.acquire([protectedRoot]),
      /protected root overlaps an active trusted-host mutation/,
    );

    finishMutation();
    await mutation;
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("rejects a dangling symlink mutation path into an active lease", async () => {
  const fixture = await makeRoot("dangling-symlink");
  try {
    const protectedRoot = path.join(fixture, "protected");
    const alias = path.join(fixture, "alias");
    await mkdir(protectedRoot);
    await symlink(path.join(protectedRoot, "future.json"), alias);
    const coordinator = new ProtectedRootLeaseCoordinator();

    await coordinator.withLease([protectedRoot], () =>
      assert.rejects(
        coordinator.runMutation([alias], () => writeFile(alias, "mutated")),
        /overlaps an active protected root lease/,
      ),
    );
    await assert.rejects(access(path.join(protectedRoot, "future.json")));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("allows a trusted-host mutation after its lease is released", async () => {
  const fixture = await makeRoot("lease-release");
  try {
    const protectedRoot = path.join(fixture, "protected");
    const protectedFile = path.join(protectedRoot, "policy.json");
    await mkdir(protectedRoot);
    const coordinator = new ProtectedRootLeaseCoordinator();
    const lease = await coordinator.acquire([protectedRoot]);
    lease.release();

    await coordinator.runMutation([protectedFile], () =>
      writeFile(protectedFile, "allowed"),
    );

    assert.equal(await readFile(protectedFile, "utf8"), "allowed");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("allows non-overlapping trusted-host mutations during a lease", async () => {
  const fixture = await makeRoot("lease-non-overlap");
  try {
    const protectedRoot = path.join(fixture, "protected");
    const unrelatedFile = path.join(fixture, "unrelated", "file.txt");
    await Promise.all([
      mkdir(protectedRoot),
      mkdir(path.dirname(unrelatedFile), { recursive: true }),
    ]);
    const coordinator = new ProtectedRootLeaseCoordinator();

    await coordinator.withLease([protectedRoot], () =>
      coordinator.runMutation([unrelatedFile], () =>
        writeFile(unrelatedFile, "allowed"),
      ),
    );

    assert.equal(await readFile(unrelatedFile, "utf8"), "allowed");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
