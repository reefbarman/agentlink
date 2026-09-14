import {
  attachmentPathsFromText,
  pastedAttachmentPaths,
  resolveCliAttachments,
} from "./attachments.js";
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";

import path from "node:path";
import { tmpdir } from "node:os";

describe("CLI attachments", () => {
  it("only infers a single pasted path and leaves ordinary mentions alone", () => {
    expect(attachmentPathsFromText("Review @src/a.ts and @docs/b.md")).toEqual(
      [],
    );
    expect(attachmentPathsFromText("@here please review this")).toEqual([]);
    expect(pastedAttachmentPaths("assets/screenshot.png")).toEqual([
      "assets/screenshot.png",
    ]);
    expect(pastedAttachmentPaths("one.png\ntwo.pdf")).toEqual([]);
    expect(pastedAttachmentPaths("ordinary prompt text")).toEqual([]);
  });

  it("inlines text, forwards media, and keeps display metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentlink-attachments-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "note.txt"), "hello\n");
    await writeFile(
      path.join(root, "image.png"),
      Buffer.from("iVBORw0KGgo=", "base64"),
    );

    const resolved = await resolveCliAttachments(root, "Please review", [
      "src/note.txt",
      "image.png",
    ]);

    expect(resolved.text).toContain(
      '<file path="src/note.txt">\nhello\n\n</file>',
    );
    expect(resolved.text).toContain("Please review");
    expect(resolved.attachments).toEqual([
      expect.objectContaining({
        display: expect.objectContaining({
          name: "src/note.txt",
          kind: "file",
        }),
      }),
      expect.objectContaining({
        display: expect.objectContaining({ name: "image.png", kind: "image" }),
        model: expect.objectContaining({ type: "image" }),
      }),
    ]);
  });

  it("rejects attachment paths outside the project", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agentlink-attachments-root-"),
    );
    const outside = await mkdtemp(
      path.join(tmpdir(), "agentlink-attachments-outside-"),
    );
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "secret");

    await expect(
      resolveCliAttachments(root, "", [outsideFile]),
    ).rejects.toThrow("outside the project");
  });
});
