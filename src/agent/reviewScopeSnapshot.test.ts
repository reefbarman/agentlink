import * as os from "os";
import * as path from "path";

import {
  assertReviewScopeAvailable,
  captureReviewScope,
} from "./reviewScopeSnapshot.js";
import { describe, expect, it } from "vitest";

async function createRoot(prefix: string): Promise<string> {
  const fs = await import("fs/promises");
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("captureReviewScope", () => {
  it("renders working-tree selectors without capturing workspace content", async () => {
    const cwd = await createRoot("review-live-tree-");
    const handoff = captureReviewScope(cwd, {
      kind: "working_tree",
      include: ["staged", "unstaged", "untracked"],
      paths: ["src/review.ts"],
      excludePaths: ["dist"],
    });

    expect(handoff).toMatchObject({
      kind: "working_tree",
      inlineBytes: 0,
    });
    expect(handoff.summary).toContain("current working tree");
    expect(handoff.content).toContain("Live review target");
    expect(handoff.content).toContain(
      `Git root: ${await import("fs/promises").then((fs) => fs.realpath(cwd))}`,
    );
    expect(handoff.content).toContain(
      "Included states: staged, unstaged, untracked",
    );
    expect(handoff.content).toContain("Paths: src/review.ts");
    expect(handoff.content).toContain("Excluded paths: dist");
    expect(handoff.content).toContain("current workspace state");
  });

  it("does not require a Git repository for a live working-tree target", async () => {
    const cwd = await createRoot("review-live-no-git-");

    expect(
      captureReviewScope(cwd, {
        kind: "working_tree",
        paths: ["src/review.ts"],
      }).content,
    ).toContain("Kind: working_tree");
  });

  it("renders available live file paths without reading their contents", async () => {
    const fs = await import("fs/promises");
    const cwd = await createRoot("review-live-files-");
    await fs.mkdir(path.join(cwd, "src"));
    await fs.writeFile(path.join(cwd, "src/review.ts"), "secret fixture body");
    await fs.writeFile(path.join(cwd, "README.md"), "readme fixture body");
    const handoff = captureReviewScope(cwd, {
      kind: "files",
      paths: ["src/review.ts", "README.md"],
    });

    expect(handoff).toMatchObject({
      kind: "files",
      inlineBytes: 0,
      summary: "current files: src/review.ts, README.md",
    });
    expect(handoff.content).toContain("Paths: src/review.ts, README.md");
    expect(handoff.content).not.toContain("secret fixture body");
  });

  it("rejects missing and non-file live file targets", async () => {
    const fs = await import("fs/promises");
    const cwd = await createRoot("review-live-files-invalid-");
    await fs.mkdir(path.join(cwd, "directory"));

    expect(() =>
      captureReviewScope(cwd, {
        kind: "files",
        paths: ["missing.ts"],
      }),
    ).toThrow(/file target is unavailable: missing\.ts/);
    expect(() =>
      captureReviewScope(cwd, {
        kind: "files",
        paths: ["directory"],
      }),
    ).toThrow(/file target is not a file: directory/);
  });

  it("revalidates live file targets before queued review work starts", async () => {
    const fs = await import("fs/promises");
    const cwd = await createRoot("review-live-files-revalidate-");
    const filePath = path.join(cwd, "review.ts");
    await fs.writeFile(filePath, "review fixture");
    const handoff = captureReviewScope(cwd, {
      kind: "files",
      paths: ["review.ts"],
    });

    expect(() => assertReviewScopeAvailable(handoff)).not.toThrow();
    await fs.rm(filePath);
    expect(() => assertReviewScopeAvailable(handoff)).toThrow(
      /became unavailable before the review started/,
    );
  });

  it("renders absolute file paths when a live target spans roots", async () => {
    const firstRoot = await createRoot("review-live-first-");
    const secondRoot = await createRoot("review-live-second-");
    const fs = await import("fs/promises");
    const firstFile = path.join(firstRoot, "README.md");
    const secondFile = path.join(secondRoot, "README.md");
    await fs.writeFile(firstFile, "first");
    await fs.writeFile(secondFile, "second");

    const handoff = captureReviewScope(
      firstRoot,
      { kind: "files", paths: [firstFile, secondFile] },
      { workspaceRoots: [firstRoot, secondRoot] },
    );

    expect(handoff.content).toContain(firstFile);
    expect(handoff.content).toContain(secondFile);
  });

  it("rejects paths outside open workspace roots", async () => {
    const cwd = await createRoot("review-live-contained-");

    expect(() =>
      captureReviewScope(
        cwd,
        { kind: "files", paths: ["../outside.ts"] },
        { workspaceRoots: [cwd] },
      ),
    ).toThrow(/outside the open workspace roots.*Accepted example/);
  });

  it("rejects Git selectors spanning roots", async () => {
    const firstRoot = await createRoot("review-live-git-first-");
    const secondRoot = await createRoot("review-live-git-second-");

    expect(() =>
      captureReviewScope(
        firstRoot,
        {
          kind: "working_tree",
          paths: [
            path.join(firstRoot, "src/one.ts"),
            path.join(secondRoot, "src/two.ts"),
          ],
        },
        { workspaceRoots: [firstRoot, secondRoot] },
      ),
    ).toThrow(/cannot span multiple workspace roots.*kind "files"/);
  });

  it("rejects Git path filters when exclusions remove every path", async () => {
    const cwd = await createRoot("review-live-all-excluded-");

    expect(() =>
      captureReviewScope(cwd, {
        kind: "working_tree",
        paths: ["generated/output.ts"],
        excludePaths: ["generated"],
      }),
    ).toThrow(/requires at least one non-excluded path/);
  });

  it("selects a named or absolute root for Git selectors", async () => {
    const firstRoot = await createRoot("review-live-root-first-");
    const secondRoot = await createRoot("review-live-root-second-");

    const handoff = captureReviewScope(
      firstRoot,
      { kind: "working_tree", root: secondRoot },
      { workspaceRoots: [firstRoot, secondRoot] },
    );

    expect(handoff.content).toContain(
      `Git root: ${await import("fs/promises").then((fs) => fs.realpath(secondRoot))}`,
    );
    expect(() =>
      captureReviewScope(
        firstRoot,
        { kind: "working_tree", root: "/nonexistent/root" },
        { workspaceRoots: [firstRoot, secondRoot] },
      ),
    ).toThrow(/does not match an open workspace root/);
  });

  it("renders a live commit range without resolving its diff", async () => {
    const cwd = await createRoot("review-live-range-");
    const handoff = captureReviewScope(cwd, {
      kind: "commit_range",
      range: "base..HEAD",
      paths: ["src/review.ts"],
    });

    expect(handoff).toMatchObject({
      kind: "commit_range",
      inlineBytes: 0,
      summary: "current Git range base..HEAD for src/review.ts",
    });
    expect(handoff.content).toContain("Git range: base..HEAD");
    expect(handoff.content).not.toContain("diff --git");
  });

  it("rejects invalid commit ranges", async () => {
    const cwd = await createRoot("review-live-range-invalid-");

    expect(() =>
      captureReviewScope(cwd, { kind: "commit_range", range: "--stat" }),
    ).toThrow(/requires a valid Git range/);
  });

  it("keeps caller-supplied diffs as the explicit immutable escape hatch", async () => {
    const cwd = await createRoot("review-inline-diff-");
    const content = "diff --git a/a.ts b/a.ts\n+const value = 2;\n";
    const handoff = captureReviewScope(cwd, {
      kind: "diff",
      label: "Foreground delta",
      content,
    });

    expect(handoff).toMatchObject({
      kind: "diff",
      inlineBytes: Buffer.byteLength(content),
      summary: "Foreground delta",
    });
    expect(handoff.content).toContain("Explicit review diff");
    expect(handoff.content).toContain("+const value = 2;");
  });

  it("bounds explicit inline diffs", async () => {
    const cwd = await createRoot("review-inline-large-");

    expect(() =>
      captureReviewScope(cwd, {
        kind: "diff",
        content: "x".repeat(1_000_001),
      }),
    ).toThrow(/above the 1000000-byte limit.*live working_tree/);
  });
});
