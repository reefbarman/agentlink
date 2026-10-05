import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

const captured = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock("../../../src/updates/ReleaseUpdateService.js", () => ({
  ReleaseUpdateService: class {
    constructor(options: unknown) {
      captured.options.push(options);
    }
  },
}));

const { createDesktopReleaseUpdateService } =
  await import("./desktopReleaseUpdates.js");
const directories: string[] = [];
afterEach(async () => {
  captured.options.length = 0;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(preferences = "{}"): Promise<{
  preferencesPath: string;
  userData: string;
}> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agentlink-desktop-updates-"),
  );
  directories.push(directory);
  const preferencesPath = path.join(directory, "desktop-preferences.json");
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(preferencesPath, preferences),
  );
  return { preferencesPath, userData: path.join(directory, "user-data") };
}

function fakeApp(userData: string, isPackaged: boolean) {
  return {
    getVersion: () => "0.3.0",
    getPath: () => userData,
    isPackaged,
  };
}

describe("Desktop release update composition", () => {
  it("uses the Desktop app version and defaults automatic checks on only when packaged", async () => {
    const packaged = await fixture();
    await createDesktopReleaseUpdateService(
      fakeApp(packaged.userData, true),
      packaged.preferencesPath,
    );
    expect(captured.options[0]).toMatchObject({
      identity: {
        product: "desktop",
        version: "0.3.0",
        target: `${process.platform}-${process.arch}`,
        development: false,
      },
      storageDirectory: path.join(packaged.userData, "updates"),
      automaticChecks: true,
    });

    const development = await fixture();
    await createDesktopReleaseUpdateService(
      fakeApp(development.userData, false),
      development.preferencesPath,
    );
    expect(captured.options[1]).toMatchObject({
      identity: { version: "0.3.0", development: true },
      automaticChecks: false,
    });
  });

  it("honours and persists the Desktop-local automatic-check preference", async () => {
    const { preferencesPath, userData } = await fixture(
      JSON.stringify({
        automaticUpdateChecks: false,
        quickAskShortcut: "Command+K",
      }),
    );
    await createDesktopReleaseUpdateService(
      fakeApp(userData, true),
      preferencesPath,
    );
    const options = captured.options[0] as {
      automaticChecks: boolean;
      saveAutomaticChecks(value: boolean): Promise<void>;
    };
    expect(options.automaticChecks).toBe(false);
    await options.saveAutomaticChecks(true);
    expect(JSON.parse(await readFile(preferencesPath, "utf8"))).toEqual({
      automaticUpdateChecks: true,
      quickAskShortcut: "Command+K",
    });
  });
});
