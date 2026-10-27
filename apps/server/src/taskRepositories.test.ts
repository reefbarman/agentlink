import {
  MAX_VALIDATION_COMMANDS,
  openRepositorySettings,
  parseValidationCommands,
  repositoryKey,
} from "./taskRepositories.js";
import { afterEach, describe, expect, it } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];

async function settingsFile(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-repos-"));
  roots.push(root);
  return path.join(root, "tasks", "repositories.json");
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    ),
  );
});

describe("repositoryKey", () => {
  it("gives every spelling of a repository URL the same key", () => {
    expect(repositoryKey("https://github.com/Octocat/Hello-World.git")).toBe(
      "https://github.com/octocat/hello-world",
    );
    expect(repositoryKey("https://GitHub.com/octocat/hello-world/")).toBe(
      "https://github.com/octocat/hello-world",
    );
  });
});

describe("parseValidationCommands", () => {
  it("trims commands and rejects bad input", () => {
    expect(parseValidationCommands(["  npm test ", "npm run lint"])).toEqual([
      "npm test",
      "npm run lint",
    ]);
    expect(() => parseValidationCommands("npm test")).toThrow(
      "validation_invalid",
    );
    expect(() => parseValidationCommands(["  "])).toThrow(
      "validation_command_invalid",
    );
    expect(() =>
      parseValidationCommands(
        Array.from({ length: MAX_VALIDATION_COMMANDS + 1 }, () => "true"),
      ),
    ).toThrow("too_many_validation_commands");
  });
});

describe("openRepositorySettings", () => {
  it("persists commands per repository and clears them when emptied", async () => {
    const file = await settingsFile();
    const store = await openRepositorySettings({ file });
    expect(store.get("https://github.com/octocat/Hello-World")).toBeUndefined();

    await store.set(
      "https://github.com/octocat/Hello-World.git",
      ["npm test"],
      5,
    );
    const reopened = await openRepositorySettings({ file });
    expect(reopened.get("https://github.com/OCTOCAT/hello-world")).toEqual({
      repository: "https://github.com/octocat/hello-world",
      validation: ["npm test"],
      updatedAt: 5,
    });

    await reopened.set("https://github.com/octocat/hello-world", [], 6);
    expect(reopened.list()).toEqual([]);
    expect((await openRepositorySettings({ file })).list()).toEqual([]);
  });

  it("refuses to start over an unreadable settings file", async () => {
    const file = await settingsFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{not json");
    await expect(openRepositorySettings({ file })).rejects.toThrow(
      "Repository settings are unreadable",
    );
  });

  it("returns nothing for a repository URL it cannot parse", async () => {
    const store = await openRepositorySettings({ file: await settingsFile() });
    expect(store.get("not a url")).toBeUndefined();
  });
});
