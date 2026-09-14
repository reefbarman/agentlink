import {
  WorkspaceOwnershipConflictError,
  acquireWorkspaceOwnership,
} from "./workspaceOwnership.js";
import { describe, expect, it } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceProject } from "./projectIdentity.js";

interface StoredOwner {
  root: string;
  filesystemIdentity: { device: string; inode: string };
  ownerNonce: string;
  hostname: string;
  pid: number;
  processStartIdentity?: string;
}

interface StoredRegistry {
  version: number;
  owners: StoredOwner[];
}

async function createFixture(): Promise<{
  parent: string;
  dataRoot: string;
  projectRoot: string;
}> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-owner-"));
  const dataRoot = path.join(parent, "data");
  const projectRoot = path.join(parent, "project");
  await fs.mkdir(projectRoot);
  return { parent, dataRoot, projectRoot };
}

async function readRegistry(dataRoot: string): Promise<StoredRegistry> {
  return JSON.parse(
    await fs.readFile(path.join(dataRoot, "workspace-owners.json"), "utf8"),
  ) as StoredRegistry;
}

async function writeRegistry(
  dataRoot: string,
  registry: StoredRegistry,
): Promise<void> {
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.writeFile(
    path.join(dataRoot, "workspace-owners.json"),
    `${JSON.stringify(registry)}\n`,
  );
}

describe("acquireWorkspaceOwnership", () => {
  it("publishes private ownership metadata and releases idempotently", async () => {
    const { dataRoot, projectRoot } = await createFixture();
    const identity = await resolveWorkspaceProject(projectRoot);

    const handle = await acquireWorkspaceOwnership(identity, dataRoot);
    const registry = await readRegistry(dataRoot);

    expect(registry).toMatchObject({
      version: 1,
      owners: [
        {
          root: identity.root,
          filesystemIdentity: identity.filesystemIdentity,
          ownerNonce: handle.ownerNonce,
          hostname: os.hostname(),
          pid: process.pid,
        },
      ],
    });
    expect(registry.owners[0]?.ownerNonce).toMatch(/^[0-9a-f-]{36}$/u);

    if (process.platform !== "win32") {
      const directoryMode = (await fs.stat(dataRoot)).mode & 0o777;
      const fileMode =
        (await fs.stat(path.join(dataRoot, "workspace-owners.json"))).mode &
        0o777;
      expect(directoryMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    }

    await handle.release();
    await handle.release();
    expect(await readRegistry(dataRoot)).toEqual({ version: 1, owners: [] });
  });

  it("rejects a second live owner and permits ownership after release", async () => {
    const { dataRoot, projectRoot } = await createFixture();
    const identity = await resolveWorkspaceProject(projectRoot);
    const first = await acquireWorkspaceOwnership(identity, dataRoot);

    await expect(acquireWorkspaceOwnership(identity, dataRoot)).rejects.toThrow(
      WorkspaceOwnershipConflictError,
    );

    await first.release();
    const next = await acquireWorkspaceOwnership(identity, dataRoot);
    await next.release();
  });

  it("rejects ancestor and descendant roots but not raw-prefix siblings", async () => {
    const { parent, dataRoot, projectRoot } = await createFixture();
    const childRoot = path.join(projectRoot, "child");
    const prefixSiblingRoot = `${projectRoot}-other`;
    await fs.mkdir(childRoot);
    await fs.mkdir(prefixSiblingRoot);

    const parentIdentity = await resolveWorkspaceProject(projectRoot);
    const childIdentity = await resolveWorkspaceProject(childRoot);
    const siblingIdentity = await resolveWorkspaceProject(prefixSiblingRoot);
    const parentHandle = await acquireWorkspaceOwnership(
      parentIdentity,
      dataRoot,
    );

    await expect(
      acquireWorkspaceOwnership(childIdentity, dataRoot),
    ).rejects.toThrow(WorkspaceOwnershipConflictError);

    const siblingHandle = await acquireWorkspaceOwnership(
      siblingIdentity,
      dataRoot,
    );
    await siblingHandle.release();
    await parentHandle.release();

    const childHandle = await acquireWorkspaceOwnership(
      childIdentity,
      dataRoot,
    );
    await expect(
      acquireWorkspaceOwnership(parentIdentity, dataRoot),
    ).rejects.toThrow(WorkspaceOwnershipConflictError);
    await childHandle.release();

    await fs.rm(parent, { recursive: true, force: true });
  });

  it("reclaims an owner after definite same-host ESRCH", async () => {
    const { dataRoot, projectRoot } = await createFixture();
    const identity = await resolveWorkspaceProject(projectRoot);
    await writeRegistry(dataRoot, {
      version: 1,
      owners: [
        {
          root: identity.root,
          filesystemIdentity: identity.filesystemIdentity,
          ownerNonce: "stale-owner",
          hostname: os.hostname(),
          pid: 2_147_483_647,
        },
      ],
    });

    const replacement = await acquireWorkspaceOwnership(identity, dataRoot);
    expect((await readRegistry(dataRoot)).owners).toHaveLength(1);
    expect((await readRegistry(dataRoot)).owners[0]?.ownerNonce).toBe(
      replacement.ownerNonce,
    );
    await replacement.release();
  });

  it("reclaims a live PID only after a proven process-start mismatch", async () => {
    const { dataRoot, projectRoot } = await createFixture();
    const identity = await resolveWorkspaceProject(projectRoot);
    const initial = await acquireWorkspaceOwnership(identity, dataRoot);
    const owner = (await readRegistry(dataRoot)).owners[0];
    await initial.release();

    expect(owner?.processStartIdentity).toBeTypeOf("string");
    const separator = owner!.processStartIdentity!.indexOf(":");
    const kind = owner!.processStartIdentity!.slice(0, separator + 1);
    await writeRegistry(dataRoot, {
      version: 1,
      owners: [
        {
          ...owner!,
          ownerNonce: "reused-pid-owner",
          processStartIdentity: `${kind}definitely-different`,
        },
      ],
    });

    const replacement = await acquireWorkspaceOwnership(identity, dataRoot);
    expect((await readRegistry(dataRoot)).owners[0]?.ownerNonce).toBe(
      replacement.ownerNonce,
    );
    await replacement.release();
  });

  it("fails closed for foreign-host and ambiguous owners", async () => {
    const { dataRoot, projectRoot } = await createFixture();
    const identity = await resolveWorkspaceProject(projectRoot);
    const owner: StoredOwner = {
      root: identity.root,
      filesystemIdentity: identity.filesystemIdentity,
      ownerNonce: "foreign-owner",
      hostname: `${os.hostname()}-other`,
      pid: process.pid,
    };
    await writeRegistry(dataRoot, { version: 1, owners: [owner] });

    await expect(acquireWorkspaceOwnership(identity, dataRoot)).rejects.toThrow(
      /another host/u,
    );

    await writeRegistry(dataRoot, {
      version: 1,
      owners: [{ ...owner, hostname: os.hostname(), ownerNonce: "ambiguous" }],
    });
    await expect(acquireWorkspaceOwnership(identity, dataRoot)).rejects.toThrow(
      /owner process is live/u,
    );
  });

  it("applies the same definite-death rule to lock recovery", async () => {
    const { dataRoot, projectRoot } = await createFixture();
    const identity = await resolveWorkspaceProject(projectRoot);
    await fs.mkdir(dataRoot, { recursive: true });

    await fs.writeFile(
      path.join(dataRoot, "workspace-owners.lock"),
      `${JSON.stringify({
        version: 1,
        ownerNonce: "stale-lock",
        hostname: os.hostname(),
        pid: 2_147_483_647,
      })}\n`,
      { mode: 0o600 },
    );

    const recovered = await acquireWorkspaceOwnership(identity, dataRoot);
    await recovered.release();

    await fs.writeFile(
      path.join(dataRoot, "workspace-owners.lock"),
      `${JSON.stringify({
        version: 1,
        ownerNonce: "foreign-lock",
        hostname: `${os.hostname()}-other`,
        pid: process.pid,
      })}\n`,
      { mode: 0o600 },
    );
    await expect(acquireWorkspaceOwnership(identity, dataRoot)).rejects.toThrow(
      /another host/u,
    );
  });

  it("requires an explicit absolute data root", async () => {
    const { projectRoot } = await createFixture();
    const identity = await resolveWorkspaceProject(projectRoot);

    await expect(
      acquireWorkspaceOwnership(identity, "relative-data"),
    ).rejects.toThrow(/absolute path/u);
  });
});
