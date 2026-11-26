import { BaseSequencer, type TestSpecification } from "vitest/node";

const PART_FILE = /\.part\d+(\.test\.[cm]?[jt]sx?)$/;

/**
 * Starts each `*.partN.test.*` file straight after the file whose tests it
 * runs (see src/testing/testParts.ts).
 *
 * Vitest starts the files it expects to be slow first. Without timings from an
 * earlier run, as in CI and preflight's fresh checkout, it judges that by file
 * size, which leaves the tiny part files until last and loses the time they
 * were added to save.
 */
export class TestPartsSequencer extends BaseSequencer {
  override async sort(
    files: TestSpecification[],
  ): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const partsByOwner = new Map<string, TestSpecification[]>();
    const others: TestSpecification[] = [];
    for (const file of sorted) {
      const owner = file.moduleId.replace(PART_FILE, "$1");
      if (owner === file.moduleId) {
        others.push(file);
      } else {
        partsByOwner.set(owner, [...(partsByOwner.get(owner) ?? []), file]);
      }
    }
    const ordered = others.flatMap((file) => {
      const parts = partsByOwner.get(file.moduleId) ?? [];
      partsByOwner.delete(file.moduleId);
      return [file, ...parts];
    });
    // Parts selected without their owning file, for example by a name filter.
    return [...ordered, ...[...partsByOwner.values()].flat()];
  }
}
