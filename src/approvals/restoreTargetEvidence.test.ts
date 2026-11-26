import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  MAX_RESTORE_DIFF_CHARS,
  MAX_RESTORE_TARGETS,
  collectRestoreTargetEvidence,
  type RestoreTargetEvidenceContext,
} from "./restoreTargetEvidence.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { execFileSync } from "node:child_process";
import { hashWorkHistoryContent } from "../core/workHistory.js";

// Real git subprocesses: allow for a loaded full-suite run.
const TIMEOUT_MS = 30_000;

const COMMITTED = "export const a = 1;\n";
const EDITED = "export const a = 2;\n";

describe("collectRestoreTargetEvidence", () => {
  let root: string;
  let ctx: RestoreTargetEvidenceContext;

  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: root, stdio: "pipe" },
    );
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  const state = (content: string) => ({
    exists: true,
    hash: hashWorkHistoryContent(true, content),
  });

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-restore-evidence-")),
    );
    ctx = { cwd: root, workspaceRoots: [root] };
    git("init", "-q");
    write("src/a.ts", COMMITTED);
    write("src/b.ts", "export const b = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "initial");
  }, TIMEOUT_MS);

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it(
    "returns nothing for commands that restore no working-tree paths",
    async () => {
      write("src/a.ts", EDITED);
      for (const command of [
        "npm test",
        "git status --short",
        "git checkout main",
        "git checkout -b feature/x",
        "git restore --staged -- src/a.ts",
        "git restore -S src/a.ts",
      ]) {
        expect(await collectRestoreTargetEvidence(command, ctx)).toEqual({});
      }
    },
    TIMEOUT_MS,
  );

  it(
    "measures the diff a file restore would discard",
    async () => {
      write("src/a.ts", EDITED);

      const evidence = await collectRestoreTargetEvidence(
        "git checkout -- src/a.ts && git status --short",
        ctx,
      );

      expect(evidence.restoreTargetsOmitted).toBe(0);
      expect(evidence.restoreTargets).toHaveLength(1);
      const [target] = evidence.restoreTargets!;
      expect(target).toMatchObject({
        target: "src/a.ts",
        resolvedPath: path.join(root, "src", "a.ts"),
        insideWorkspace: true,
        kind: "file",
        sourceKind: "index",
        sourceRef: null,
        changedFileCount: 1,
        sampleChangedFiles: ["src/a.ts"],
        linesAdded: 1,
        linesRemoved: 1,
        diffTruncated: false,
        diffUnavailableReason: null,
        // No session record was supplied.
        sessionEdited: null,
        cleanBeforeSessionEdits: null,
        changedOutsideSessionEdits: null,
      });
      expect(target!.diff).toContain("-export const a = 1;");
      expect(target!.diff).toContain("+export const a = 2;");
    },
    TIMEOUT_MS,
  );

  it(
    "reports a restore whose whole diff is the session's own edits",
    async () => {
      write("src/a.ts", EDITED);

      const evidence = await collectRestoreTargetEvidence(
        "git restore src/a.ts",
        {
          ...ctx,
          describeSessionFile: (absolutePath) => {
            expect(absolutePath).toBe(path.join(root, "src", "a.ts"));
            return {
              complete: true,
              file: {
                firstBefore: state(COMMITTED),
                lastAfter: state(EDITED),
                continuous: true,
              },
            };
          },
        },
      );

      expect(evidence.restoreTargets![0]).toMatchObject({
        sessionEdited: true,
        cleanBeforeSessionEdits: true,
        changedOutsideSessionEdits: false,
      });
    },
    TIMEOUT_MS,
  );

  it(
    "reports pre-existing and outside changes around session edits",
    async () => {
      // The file was already dirty before the session edited it, and a
      // formatter or another writer changed it again afterwards.
      write("src/a.ts", "export const a = 3; // later\n");

      const evidence = await collectRestoreTargetEvidence(
        "git checkout HEAD -- src/a.ts",
        {
          ...ctx,
          describeSessionFile: () => ({
            complete: true,
            file: {
              firstBefore: state("export const a = 1; // mine\n"),
              lastAfter: state(EDITED),
              continuous: true,
            },
          }),
        },
      );

      expect(evidence.restoreTargets![0]).toMatchObject({
        sourceKind: "tree",
        sourceRef: "HEAD",
        sessionEdited: true,
        cleanBeforeSessionEdits: false,
        changedOutsideSessionEdits: true,
      });
    },
    TIMEOUT_MS,
  );

  it(
    "only says the session never edited a file when its record is complete",
    async () => {
      write("src/a.ts", EDITED);
      const collect = (complete: boolean) =>
        collectRestoreTargetEvidence("git checkout -- src/a.ts", {
          ...ctx,
          describeSessionFile: () => ({ complete }),
        });

      expect((await collect(true)).restoreTargets![0]!.sessionEdited).toBe(
        false,
      );
      expect((await collect(false)).restoreTargets![0]!.sessionEdited).toBe(
        null,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "keeps directory and unchanged targets free of diff and session facts",
    async () => {
      write("src/a.ts", EDITED);
      write("src/b.ts", "export const b = 2;\n");

      const evidence = await collectRestoreTargetEvidence(
        "git checkout -- . src/missing.ts",
        { ...ctx, describeSessionFile: () => ({ complete: true }) },
      );

      expect(evidence.restoreTargets).toHaveLength(2);
      expect(evidence.restoreTargets![0]).toMatchObject({
        target: ".",
        kind: "directory",
        changedFileCount: 2,
        sampleChangedFiles: ["src/a.ts", "src/b.ts"],
        diff: null,
        diffUnavailableReason: "not_a_single_file",
        sessionEdited: null,
      });
      expect(evidence.restoreTargets![1]).toMatchObject({
        target: "src/missing.ts",
        kind: null,
        changedFileCount: 0,
        diffUnavailableReason: "not_a_single_file",
      });

      git("checkout", "--", ".");
      const clean = await collectRestoreTargetEvidence(
        "git checkout -- src/a.ts",
        ctx,
      );
      expect(clean.restoreTargets![0]).toMatchObject({
        changedFileCount: 0,
        diff: null,
        diffUnavailableReason: "no_changes",
      });
    },
    TIMEOUT_MS,
  );

  it(
    "leaves staged-only changes out of an index restore",
    async () => {
      write("src/a.ts", EDITED);
      git("add", "src/a.ts");

      const evidence = await collectRestoreTargetEvidence(
        "git checkout -- src/a.ts",
        ctx,
      );

      expect(evidence.restoreTargets![0]).toMatchObject({
        changedFileCount: 0,
        diffUnavailableReason: "no_changes",
      });
    },
    TIMEOUT_MS,
  );

  it(
    "does not measure paths it cannot place",
    async () => {
      write("src/a.ts", EDITED);

      const moved = await collectRestoreTargetEvidence(
        "cd src && git checkout -- a.ts",
        ctx,
      );
      expect(moved.restoreTargets![0]).toMatchObject({
        target: "a.ts",
        diff: null,
        diffUnavailableReason: "cwd_uncertain",
      });

      const outside = await collectRestoreTargetEvidence(
        "git checkout -- ../elsewhere.ts $FILE",
        ctx,
      );
      expect(outside.restoreTargets![0]).toMatchObject({
        insideWorkspace: false,
        diffUnavailableReason: "outside_workspace",
      });
      expect(outside.restoreTargets![1]).toMatchObject({
        target: "$FILE",
        diffUnavailableReason: "unresolved_path",
      });

      const conflictSide = await collectRestoreTargetEvidence(
        "git checkout --ours -- src/a.ts",
        ctx,
      );
      expect(conflictSide.restoreTargets![0]).toMatchObject({
        sourceKind: "ours",
        diff: null,
        diffUnavailableReason: "conflict_side",
      });
    },
    TIMEOUT_MS,
  );

  it(
    "bounds the diff and the number of targets",
    async () => {
      write(
        "src/a.ts",
        Array.from({ length: 2_000 }, (_, i) => `export const v${i} = ${i};`)
          .join("\n")
          .concat("\n"),
      );
      const extra = Array.from({ length: MAX_RESTORE_TARGETS + 2 }, () => "x");

      const evidence = await collectRestoreTargetEvidence(
        `git checkout -- src/a.ts ${extra.join(" ")}`,
        ctx,
      );

      expect(evidence.restoreTargets).toHaveLength(MAX_RESTORE_TARGETS);
      expect(evidence.restoreTargetsOmitted).toBe(3);
      expect(evidence.restoreTargets![0]).toMatchObject({
        diffTruncated: true,
        linesAdded: 2_000,
        linesRemoved: 1,
      });
      expect(evidence.restoreTargets![0]!.diff).toHaveLength(
        MAX_RESTORE_DIFF_CHARS,
      );
    },
    TIMEOUT_MS,
  );

  it("never throws on unparseable input", async () => {
    await expect(
      collectRestoreTargetEvidence("git checkout -- $(broken `sub", ctx),
    ).resolves.toBeDefined();
    await expect(collectRestoreTargetEvidence("", ctx)).resolves.toEqual({});
  });
});
