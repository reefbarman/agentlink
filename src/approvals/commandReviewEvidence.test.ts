import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_DELETION_TARGETS,
  MAX_REFERENCED_SCRIPT_CONTENT_CHARS,
  collectCommandReviewEvidence,
} from "./commandReviewEvidence.js";

describe("collectCommandReviewEvidence", () => {
  let root: string;
  let ctx: { cwd: string; workspaceRoots: string[] };

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-evidence-")),
    );
    ctx = { cwd: root, workspaceRoots: [root] };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("referenced scripts", () => {
    it("reads a workspace script run via an interpreter", () => {
      fs.mkdirSync(path.join(root, "scripts"));
      fs.writeFileSync(
        path.join(root, "scripts", "clean.sh"),
        "#!/bin/sh\nrm -rf shots\n",
      );

      const evidence = collectCommandReviewEvidence(
        "bash scripts/clean.sh",
        ctx,
      );

      expect(evidence.referencedScripts).toHaveLength(1);
      expect(evidence.referencedScripts[0]).toMatchObject({
        reference: "scripts/clean.sh",
        resolvedPath: path.join(root, "scripts", "clean.sh"),
        insideWorkspace: true,
        exists: true,
        kind: "file",
        content: "#!/bin/sh\nrm -rf shots\n",
        contentTruncated: false,
        contentUnavailableReason: null,
      });
      expect(evidence.referencedScripts[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("reads a path-qualified executable and dedupes repeats", () => {
      fs.writeFileSync(path.join(root, "run.sh"), "echo run\n", {
        mode: 0o755,
      });

      const evidence = collectCommandReviewEvidence(
        "chmod +x ./run.sh && ./run.sh && ./run.sh",
        ctx,
      );

      expect(evidence.referencedScripts).toHaveLength(1);
      expect(evidence.referencedScripts[0]).toMatchObject({
        reference: "./run.sh",
        content: "echo run\n",
      });
    });

    it("skips interpreter flags before the script argument", () => {
      fs.writeFileSync(path.join(root, "trace.sh"), "echo traced\n");

      const evidence = collectCommandReviewEvidence("sh -x trace.sh", ctx);

      expect(evidence.referencedScripts).toHaveLength(1);
      expect(evidence.referencedScripts[0]?.content).toBe("echo traced\n");
    });

    it("does not extract a file from inline-code invocations", () => {
      const evidence = collectCommandReviewEvidence(
        "bash -c 'echo hi' && python3 -m http.server && node -e 'x()'",
        ctx,
      );

      expect(evidence.referencedScripts).toHaveLength(0);
    });

    it("marks a missing script as unavailable evidence", () => {
      const evidence = collectCommandReviewEvidence("bash nope.sh", ctx);

      expect(evidence.referencedScripts[0]).toMatchObject({
        exists: false,
        content: null,
        contentUnavailableReason: "missing",
      });
    });

    it("keeps files outside workspace and temp roots metadata-only", () => {
      const outside = "/etc/hosts";
      if (!fs.existsSync(outside)) return;

      const evidence = collectCommandReviewEvidence(`bash ${outside}`, ctx);

      expect(evidence.referencedScripts[0]).toMatchObject({
        insideWorkspace: false,
        exists: true,
        kind: "file",
        content: null,
        sha256: null,
        contentUnavailableReason: "outside_workspace",
      });
      expect(evidence.referencedScripts[0]?.bytes).toBeGreaterThan(0);
    });

    it("truncates large script contents", () => {
      fs.writeFileSync(
        path.join(root, "big.sh"),
        "x".repeat(MAX_REFERENCED_SCRIPT_CONTENT_CHARS + 100),
      );

      const evidence = collectCommandReviewEvidence("bash big.sh", ctx);

      expect(evidence.referencedScripts[0]).toMatchObject({
        contentTruncated: true,
        contentUnavailableReason: null,
      });
      expect(evidence.referencedScripts[0]?.content).toHaveLength(
        MAX_REFERENCED_SCRIPT_CONTENT_CHARS,
      );
    });
  });

  describe("deletion targets", () => {
    it("describes a literal file target", () => {
      fs.writeFileSync(path.join(root, "notes.txt"), "hello");

      const evidence = collectCommandReviewEvidence("rm -f notes.txt", ctx);

      expect(evidence.deletionTargets).toEqual([
        expect.objectContaining({
          target: "notes.txt",
          resolvedPath: path.join(root, "notes.txt"),
          glob: false,
          insideWorkspace: true,
          exists: true,
          kind: "file",
          bytes: 5,
        }),
      ]);
      expect(evidence.deletionTargetsOmitted).toBe(0);
    });

    it("describes a directory target with entry counts and samples", () => {
      const shots = path.join(root, "shots");
      fs.mkdirSync(shots);
      fs.writeFileSync(path.join(shots, "b.png"), "22");
      fs.writeFileSync(path.join(shots, "a.png"), "1");
      fs.writeFileSync(path.join(shots, "c.png"), "333");

      const evidence = collectCommandReviewEvidence(
        "mkdir backup && rm -rf shots",
        ctx,
      );

      expect(evidence.deletionTargets).toEqual([
        expect.objectContaining({
          target: "shots",
          kind: "directory",
          insideWorkspace: true,
          exists: true,
          entryCount: 3,
          sampleEntries: ["a.png", "b.png", "c.png"],
          bytes: 6,
        }),
      ]);
    });

    it("expands basename globs against the parent directory", () => {
      const shots = path.join(root, "shots");
      fs.mkdirSync(shots);
      fs.writeFileSync(path.join(shots, "a.png"), "1");
      fs.writeFileSync(path.join(shots, "b.png"), "22");
      fs.writeFileSync(path.join(shots, "keep.txt"), "keep");

      const evidence = collectCommandReviewEvidence("rm shots/*.png", ctx);

      expect(evidence.deletionTargets).toEqual([
        expect.objectContaining({
          target: "shots/*.png",
          glob: true,
          insideWorkspace: true,
          exists: true,
          entryCount: 2,
          sampleEntries: ["a.png", "b.png"],
          bytes: 3,
        }),
      ]);
    });

    it("reports symlink targets without following them", () => {
      fs.writeFileSync(path.join(root, "real.txt"), "real");
      fs.symlinkSync(path.join(root, "real.txt"), path.join(root, "link.txt"));

      const evidence = collectCommandReviewEvidence("rm link.txt", ctx);

      expect(evidence.deletionTargets[0]).toMatchObject({
        kind: "symlink",
        bytes: null,
      });
    });

    it("flags targets outside the workspace", () => {
      const evidence = collectCommandReviewEvidence("rm -rf /etc/hosts", ctx);

      expect(evidence.deletionTargets[0]).toMatchObject({
        target: "/etc/hosts",
        insideWorkspace: false,
      });
    });

    it("treats arguments after -- as targets", () => {
      const evidence = collectCommandReviewEvidence("rm -- -weird", ctx);

      expect(evidence.deletionTargets[0]?.target).toBe("-weird");
    });

    it("caps the target list and counts omissions", () => {
      const targets = Array.from({ length: 11 }, (_, i) => `f${i}.txt`);

      const evidence = collectCommandReviewEvidence(
        `rm ${targets.join(" ")}`,
        ctx,
      );

      expect(evidence.deletionTargets).toHaveLength(MAX_DELETION_TARGETS);
      expect(evidence.deletionTargetsOmitted).toBe(11 - MAX_DELETION_TARGETS);
    });
  });

  it("returns empty evidence for commands without scripts or deletions", () => {
    const evidence = collectCommandReviewEvidence("npm test", ctx);

    expect(evidence).toEqual({
      referencedScripts: [],
      deletionTargets: [],
      deletionTargetsOmitted: 0,
    });
  });

  it("never throws on malformed input", () => {
    expect(() =>
      collectCommandReviewEvidence("rm $(broken `sub", ctx),
    ).not.toThrow();
    expect(() => collectCommandReviewEvidence("", ctx)).not.toThrow();
  });
});
