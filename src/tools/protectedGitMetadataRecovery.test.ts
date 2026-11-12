import { beforeEach, describe, expect, it, vi } from "vitest";

import { protectedGitMetadataRecovery } from "./protectedGitMetadataRecovery.js";

const { resolveBaselineProtectedGitMetadataForCwd } = vi.hoisted(() => ({
  resolveBaselineProtectedGitMetadataForCwd: vi.fn(),
}));
vi.mock("../terminal/sandbox/gitMetadataProtection.js", () => ({
  resolveBaselineProtectedGitMetadataForCwd,
}));

const objectWriteDenial =
  "error: unable to create temporary file: Operation not permitted\nfatal: Unable to add (null) to database\n";

function recover(output: string, exitCode: number | null = 1) {
  return protectedGitMetadataRecovery({
    command: "node stage.mjs",
    output,
    cwd: "/workspace",
    exitCode,
    workspaceRoots: ["/workspace"],
  });
}

describe("protectedGitMetadataRecovery", () => {
  beforeEach(() => {
    resolveBaselineProtectedGitMetadataForCwd.mockReset();
    resolveBaselineProtectedGitMetadataForCwd.mockResolvedValue({
      marker: "/workspace/.git",
    });
  });

  it("recognises a denied Git object-database write that names no path", async () => {
    await expect(recover(objectWriteDenial)).resolves.toMatchObject({
      capability_code: "protected_git_metadata",
      retry_guidance: {
        code: "protected_git_metadata",
        options: [
          expect.objectContaining({
            command: "node stage.mjs",
            sandbox_permissions: "require_escalated",
          }),
        ],
      },
    });
  });

  it("needs both the temporary-file denial and the object-write failure", async () => {
    await expect(
      recover(
        "error: unable to create temporary file: Operation not permitted\n",
      ),
    ).resolves.toBeUndefined();
    await expect(
      recover(
        "error: unable to create temporary file: No space left on device\nfatal: Unable to add x to database\n",
      ),
    ).resolves.toBeUndefined();
  });

  it("ignores the signature outside a protected repository", async () => {
    resolveBaselineProtectedGitMetadataForCwd.mockResolvedValue(undefined);
    await expect(recover(objectWriteDenial)).resolves.toBeUndefined();
  });

  it("does not offer a retry when the command reported success", async () => {
    await expect(recover(objectWriteDenial, 0)).resolves.toBeUndefined();
  });
});
