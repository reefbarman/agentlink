import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProjectAttachments } from "./attachmentResolver.js";

describe("resolveProjectAttachments", () => {
  const workspaces: string[] = [];

  function makeWorkspace(): string {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-attachment-resolver-"),
    );
    workspaces.push(workspace);
    return workspace;
  }

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("converts an attached PNG into image media instead of prompt text", async () => {
    const projectRoot = makeWorkspace();
    const imageBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00,
    ]);
    fs.writeFileSync(path.join(projectRoot, "canteen.png"), imageBytes);

    const result = await resolveProjectAttachments(
      "[Attached: canteen.png]\n\nInspect this image",
      ["canteen.png"],
      projectRoot,
    );

    expect(result).toEqual({
      text: "Inspect this image",
      images: [
        {
          name: "canteen.png",
          mimeType: "image/png",
          base64: imageBytes.toString("base64"),
        },
      ],
      documents: [],
    });
    expect(result.text).not.toContain("PNG");
    expect(result.text).not.toContain("\uFFFD");
  });

  it("converts an attached PDF into document media", async () => {
    const projectRoot = makeWorkspace();
    const pdfBytes = Buffer.from("%PDF-1.7\nbinary\u0000payload", "binary");
    fs.writeFileSync(path.join(projectRoot, "brief.pdf"), pdfBytes);

    const result = await resolveProjectAttachments(
      "[Attached: brief.pdf]\n\nSummarize this",
      ["brief.pdf"],
      projectRoot,
    );

    expect(result.text).toBe("Summarize this");
    expect(result.images).toEqual([]);
    expect(result.documents).toEqual([
      {
        name: "brief.pdf",
        mimeType: "application/pdf",
        base64: pdfBytes.toString("base64"),
      },
    ]);
  });

  it("preserves valid UTF-8 text attachments as inline file blocks", async () => {
    const projectRoot = makeWorkspace();
    fs.writeFileSync(path.join(projectRoot, "notes.md"), "# Notes\nHello\n");

    const result = await resolveProjectAttachments(
      "[Attached: notes.md]\n\nUse these notes",
      ["notes.md"],
      projectRoot,
    );

    expect(result).toEqual({
      text: '<file path="notes.md">\n```md\n# Notes\nHello\n\n```\n</file>\n\nUse these notes',
      images: [],
      documents: [],
    });
  });

  it("does not decode unsupported binary files into prompt text", async () => {
    const projectRoot = makeWorkspace();
    fs.writeFileSync(
      path.join(projectRoot, "archive.bin"),
      Buffer.from([0xff, 0xfe, 0x00, 0x80]),
    );

    const result = await resolveProjectAttachments(
      "[Attached: archive.bin]\n\nInspect this",
      ["archive.bin"],
      projectRoot,
    );

    expect(result.text).toContain("[Unsupported binary attachment]");
    expect(result.text).not.toContain("\uFFFD");
    expect(result.images).toEqual([]);
    expect(result.documents).toEqual([]);
  });

  it("rejects symlinks that escape the project root", async () => {
    const workspace = makeWorkspace();
    const projectRoot = path.join(workspace, "project");
    const externalFile = path.join(workspace, "secret.txt");
    fs.mkdirSync(projectRoot);
    fs.writeFileSync(externalFile, "must-not-leak");
    fs.symlinkSync(externalFile, path.join(projectRoot, "link.txt"));

    const result = await resolveProjectAttachments(
      "[Attached: link.txt]\n\nInspect this",
      ["link.txt"],
      projectRoot,
    );

    expect(result.text).toContain("[Error: could not read file]");
    expect(result.text).not.toContain("must-not-leak");
  });
});
