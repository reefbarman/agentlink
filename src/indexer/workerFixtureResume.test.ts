import {
  TEST_TIMEOUT_MS,
  createFixture,
  createWorkspace,
  expectEmptyJournal,
  requireCache,
  setUpWorkerFixtureBuild,
  sourceContent,
  startMessage,
  stopChild,
  writeSource,
} from "./workerFixtureHarness.js";
import { describe, expect, it } from "vitest";

// The slowest worker scenario, in its own file so it runs in parallel with
// the rest of workerFixture.test.ts.
setUpWorkerFixtureBuild();

describe("indexer worker fixture", () => {
  it(
    "resumes an interrupted initial build from durably committed files",
    async () => {
      const firstFixture = await createFixture();
      const workspace = createWorkspace();
      // Two publication batches (25 + 5 at FILE_BATCH_SIZE = 25) so the build
      // can be interrupted after the first batch commits durably.
      const files = Array.from({ length: 30 }, (_, index) =>
        writeSource(
          workspace.root,
          `src/resume-${index}.sql`,
          sourceContent(index),
        ),
      );

      firstFixture.send(startMessage(workspace, { files }));
      await firstFixture.waitFor(
        "progress",
        (message) =>
          message.phase === "upserting" &&
          message.current === 25 &&
          message.total === files.length,
      );
      await stopChild(firstFixture.child);

      const durableFilesBeforeResume = Object.keys(
        requireCache(workspace).files,
      ).length;
      expect(durableFilesBeforeResume).toBeGreaterThanOrEqual(25);
      expect(durableFilesBeforeResume).toBeLessThan(files.length);
      const remainingFiles = files.length - durableFilesBeforeResume;
      const resumedFixture = await createFixture();
      const completion = resumedFixture.waitFor("complete");
      resumedFixture.send(startMessage(workspace, { files, force: false }));
      const resumedProgress = await resumedFixture.waitFor(
        "progress",
        (message) =>
          message.phase === "upserting" &&
          message.detail?.includes("already current") === true,
      );
      const stats = (await completion).stats;

      expect(resumedProgress).toMatchObject({
        current: durableFilesBeforeResume,
        total: files.length,
        detail: `${durableFilesBeforeResume} already current; ${remainingFiles} remaining in ${Math.ceil(remainingFiles / 25)} batches`,
      });
      expect(stats).toMatchObject({
        filesIndexed: remainingFiles,
        totalFilesInIndex: files.length,
        errors: [],
      });
      expect(stats.metrics?.operations["retrieval.deleteIndex"]).toBe(0);
      expect(Object.keys(requireCache(workspace).files)).toHaveLength(
        files.length,
      );
      expectEmptyJournal(workspace);
    },
    TEST_TIMEOUT_MS,
  );
});
