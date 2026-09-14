import { afterEach, describe, expect, it } from "vitest";
import {
  disableManagedTypeScriptForProject,
  enableManagedTypeScriptForProject,
  readManagedTypeScriptProjectEnablement,
} from "./managedTypeScriptEnablement.js";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];
const PROJECT_ID = "a".repeat(64);

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "managed-typescript-enablement-"),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("managed TypeScript project enablement", () => {
  it("defaults to disabled and persists a private project-scoped decision", async () => {
    const dataRoot = await fixture();
    await expect(
      readManagedTypeScriptProjectEnablement(dataRoot, PROJECT_ID),
    ).resolves.toEqual({ enabled: false });

    await expect(
      enableManagedTypeScriptForProject(dataRoot, PROJECT_ID),
    ).resolves.toMatchObject({ enabled: true });
    await expect(
      readManagedTypeScriptProjectEnablement(dataRoot, PROJECT_ID),
    ).resolves.toMatchObject({ enabled: true });

    if (process.platform !== "win32") {
      const file = path.join(
        dataRoot,
        "projects",
        PROJECT_ID,
        "language-intelligence.json",
      );
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("disables idempotently and rejects invalid project identities", async () => {
    const dataRoot = await fixture();
    await enableManagedTypeScriptForProject(dataRoot, PROJECT_ID);
    await expect(
      disableManagedTypeScriptForProject(dataRoot, PROJECT_ID),
    ).resolves.toBe(true);
    await expect(
      disableManagedTypeScriptForProject(dataRoot, PROJECT_ID),
    ).resolves.toBe(false);
    await expect(
      readManagedTypeScriptProjectEnablement(dataRoot, "../escape"),
    ).rejects.toThrow("invalid_managed_typescript_project_id");
  });
});
