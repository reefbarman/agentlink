import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OnApprovalRequest } from "@agentlink/protocol/inline-approval";
import type { SessionImageReference } from "../core/tools/types.js";
import type { WriteApprovalPolicyProvider } from "../core/capabilities/editReview.js";
import { handleSaveSessionImage } from "./saveSessionImage.js";

vi.mock("../util/paths.js", () => ({
  resolveAndValidatePath: (inputPath: string) => ({
    absolutePath: inputPath,
    inWorkspace: !inputPath.includes("outside-workspace"),
  }),
  getRelativePath: (absolutePath: string) => path.basename(absolutePath),
}));

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const sessionImages: SessionImageReference[] = [
  {
    id: "image_1",
    name: "attachment.png",
    mimeType: "image/png",
    base64: pngBase64,
    messageIndex: 0,
    imageIndex: 0,
  },
  {
    id: "image_2",
    name: "photo.jpg",
    mimeType: "image/jpeg",
    base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
    messageIndex: 3,
    imageIndex: 0,
  },
];

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "save-session-image-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function policy(allowed: boolean): WriteApprovalPolicyProvider {
  return {
    getAuthorization: vi.fn(() =>
      allowed
        ? {
            allowed: true,
            basis: "blanket_approval" as const,
            scope: "session",
          }
        : {
            allowed: false,
            basis: "none" as const,
            reason: "no_matching_write_authority",
          },
    ),
    canAutoApprove: vi.fn(() => allowed),
    recordDecision: vi.fn(),
  } as WriteApprovalPolicyProvider;
}

function deps(
  overrides: Partial<Parameters<typeof handleSaveSessionImage>[1]> = {},
) {
  return {
    sessionId: "session-1",
    getSessionImages: () => sessionImages,
    writeApprovalPolicyProvider: policy(true),
    ...overrides,
  };
}

function payload(result: Awaited<ReturnType<typeof handleSaveSessionImage>>) {
  const text = result.content.find((entry) => entry.type === "text");
  return JSON.parse(text && "text" in text ? text.text : "{}");
}

describe("handleSaveSessionImage", () => {
  it("writes the exact session image bytes when writes are already approved", async () => {
    const onApprovalRequest = vi.fn<OnApprovalRequest>();
    const target = path.join(dir, "nested", "saved.png");

    const result = await handleSaveSessionImage(
      { image_id: "image_1", path: target },
      deps({ onApprovalRequest }),
    );

    expect(result.isError).toBeFalsy();
    expect(payload(result)).toMatchObject({
      status: "saved",
      image_id: "image_1",
      path: "saved.png",
      mime_type: "image/png",
      authorization: { basis: "blanket_approval", scope: "session" },
    });
    expect(await fs.readFile(target)).toEqual(Buffer.from(pngBase64, "base64"));
    expect(onApprovalRequest).not.toHaveBeenCalled();
  });

  it("adds the matching extension and rejects mismatched ones", async () => {
    const saved = await handleSaveSessionImage(
      { image_id: "image_2", path: path.join(dir, "photo") },
      deps(),
    );
    expect(payload(saved).path).toBe("photo.jpg");
    await expect(fs.stat(path.join(dir, "photo.jpg"))).resolves.toBeTruthy();

    const mismatched = await handleSaveSessionImage(
      { image_id: "image_2", path: path.join(dir, "photo.png") },
      deps(),
    );
    expect(mismatched.isError).toBe(true);
    expect(JSON.stringify(mismatched)).toContain(
      "does not match the image type",
    );
  });

  it("refuses to overwrite unless overwrite is true", async () => {
    const target = path.join(dir, "existing.png");
    await fs.writeFile(target, "original");

    const refused = await handleSaveSessionImage(
      { image_id: "image_1", path: target },
      deps(),
    );
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("overwrite: true");
    expect(await fs.readFile(target, "utf8")).toBe("original");

    const replaced = await handleSaveSessionImage(
      { image_id: "image_1", path: target, overwrite: true },
      deps(),
    );
    expect(payload(replaced)).toMatchObject({
      status: "saved",
      overwritten: true,
    });
    expect(await fs.readFile(target)).toEqual(Buffer.from(pngBase64, "base64"));
  });

  it("asks with a file-write card and records trust decisions when not pre-approved", async () => {
    const provider = policy(false);
    const onApprovalPrompt = vi.fn();
    const onApprovalRequest = vi.fn<OnApprovalRequest>(async () => ({
      decision: "accept-session",
      trustScope: "all-files",
      followUp: "then update the README",
    }));
    const target = path.join(dir, "approved.png");

    const result = await handleSaveSessionImage(
      { image_id: "image_1", path: target },
      deps({
        mode: "code",
        writeApprovalPolicyProvider: provider,
        onApprovalRequest,
        onApprovalPrompt,
      }),
    );

    const [request, sessionId] = onApprovalRequest.mock.calls[0]!;
    expect(sessionId).toBe("session-1");
    expect(request).toMatchObject({
      kind: "write",
      title: "Create `approved.png`?",
      targetPath: target,
      fileWrite: { operation: "create", outsideWorkspace: false },
      choices: [],
    });
    expect(request.detail).toContain("Save session image image_1");
    expect(onApprovalPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        absolutePath: target,
        mode: "code",
        authorization: expect.objectContaining({ allowed: false }),
      }),
    );
    expect(provider.recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "accept-session",
        absolutePath: target,
        relativePath: "approved.png",
        inWorkspace: true,
        writeApprovalResponse: expect.objectContaining({
          trustScope: "all-files",
        }),
      }),
    );
    expect(payload(result)).toMatchObject({
      status: "saved",
      authorization: { basis: "human" },
      follow_up: "then update the README",
    });
  });

  it("writes nothing when the user rejects", async () => {
    const provider = policy(false);
    const target = path.join(dir, "rejected.png");
    const result = await handleSaveSessionImage(
      { image_id: "image_1", path: target },
      deps({
        writeApprovalPolicyProvider: provider,
        onApprovalRequest: async () => ({
          decision: "reject",
          rejectionReason: "wrong image",
        }),
      }),
    );

    expect(payload(result)).toEqual({
      status: "rejected_by_user",
      path: "rejected.png",
      reason: "wrong image",
    });
    expect(provider.recordDecision).not.toHaveBeenCalled();
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("lists available IDs for unknown images and blocks paths outside the workspace", async () => {
    const unknown = await handleSaveSessionImage(
      { image_id: "image_9", path: path.join(dir, "x.png") },
      deps(),
    );
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown)).toContain("image_1, image_2");

    const outside = await handleSaveSessionImage(
      { image_id: "image_1", path: path.join(dir, "outside-workspace.png") },
      deps(),
    );
    expect(outside.isError).toBe(true);
    expect(JSON.stringify(outside)).toContain("inside the workspace");
  });
});
