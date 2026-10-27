import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "./httpJson.js";
import {
  ProjectCloneError,
  ProjectSettingsError,
  openProjectCatalog,
  projectNetworkPolicy,
  planRepositories,
  slugifyProjectId,
  type CloneRepository,
} from "./projectCatalog.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup() {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "project-catalog-")),
  );
  cleanup.push(() =>
    fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  );
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  const file = path.join(dir, "data", "settings", "projects.json");
  const projectsRoot = path.join(dir, "projects");
  const open = (options: { projectsRoot?: string } = { projectsRoot }) =>
    openProjectCatalog({
      file,
      configProjects: [{ id: "home", label: "Home", root: home }],
      ...options,
      now: () => 1_000,
    });
  return { dir, home, file, projectsRoot, open };
}

const fakeClone: CloneRepository = async ({ cwd, directory }) => {
  await fs.mkdir(path.join(cwd, directory));
  await fs.writeFile(path.join(cwd, directory, "README.md"), "cloned\n");
};

describe("project catalog", () => {
  it("lists config projects and creates an empty project under projectsRoot", async () => {
    const { open, projectsRoot } = await setup();
    const catalog = await open();
    expect(catalog.list().map((project) => project.id)).toEqual(["home"]);
    expect(catalog.canCreate).toBe(true);

    const clone = vi.fn(fakeClone);
    const created = await catalog.create(
      { label: "  Trip   planning ", repositories: [] },
      clone,
    );
    expect(created).toMatchObject({
      id: "trip-planning",
      label: "Trip planning",
      origin: "app",
      root: path.join(projectsRoot, "trip-planning"),
      repositories: [],
      createdAt: 1_000,
    });
    expect(clone).not.toHaveBeenCalled();
    expect((await fs.stat(created.root)).isDirectory()).toBe(true);

    // Persisted: a new catalog over the same file sees it.
    const reopened = await open();
    expect(reopened.list().map((project) => project.id)).toEqual([
      "home",
      "trip-planning",
    ]);
  });

  it("clones repositories side by side and gives each its own folder", async () => {
    const { open } = await setup();
    const catalog = await open();
    const clone = vi.fn(fakeClone);
    const created = await catalog.create(
      {
        label: "Speakeasy",
        repositories: [
          "https://github.com/acme/api.git",
          "https://github.com/acme/web",
          "https://gitlab.com/other/api.git",
        ],
      },
      clone,
    );
    expect(created.repositories).toEqual([
      { url: "https://github.com/acme/api.git", directory: "api" },
      { url: "https://github.com/acme/web", directory: "web" },
      { url: "https://gitlab.com/other/api.git", directory: "api-2" },
    ]);
    const cwd = await fs.realpath(created.root);
    expect(clone).toHaveBeenCalledWith({
      url: "https://github.com/acme/api.git",
      directory: "api",
      cwd,
    });
    expect((await fs.readdir(created.root)).sort()).toEqual([
      "api",
      "api-2",
      "web",
    ]);
  });

  it("removes the folder and records nothing when a clone fails", async () => {
    const { open, projectsRoot } = await setup();
    const catalog = await open();
    let calls = 0;
    const failing: CloneRepository = async (request) => {
      calls += 1;
      if (calls === 2) {
        throw new ProjectCloneError(request.url, "Repository not found.");
      }
      await fakeClone(request);
    };
    await expect(
      catalog.create(
        {
          label: "Broken",
          repositories: [
            "https://github.com/acme/one",
            "https://github.com/acme/missing",
          ],
        },
        failing,
      ),
    ).rejects.toMatchObject({
      code: "project_clone_failed",
      detail: "Repository not found.",
    });
    expect(catalog.list().map((project) => project.id)).toEqual(["home"]);
    await expect(fs.readdir(projectsRoot)).resolves.toEqual([]);

    // The ID is free again.
    const retried = await catalog.create(
      { label: "Broken", repositories: [] },
      fakeClone,
    );
    expect(retried.id).toBe("broken");
  });

  it("never reuses a config ID, a created ID, or an existing folder", async () => {
    const { open, projectsRoot } = await setup();
    const catalog = await open();
    await fs.mkdir(path.join(projectsRoot, "notes"), { recursive: true });
    const home = await catalog.create(
      { label: "Home", repositories: [] },
      fakeClone,
    );
    expect(home.id).toBe("home-2");
    const notes = await catalog.create(
      { label: "Notes", repositories: [] },
      fakeClone,
    );
    expect(notes.id).toBe("notes-2");
    const [first, second] = await Promise.all([
      catalog.create({ label: "Same", repositories: [] }, fakeClone),
      catalog.create({ label: "Same", repositories: [] }, fakeClone),
    ]);
    expect(new Set([first.id, second.id])).toEqual(new Set(["same", "same-2"]));
  });

  it("stores per-project settings for config and created projects", async () => {
    const { open } = await setup();
    const catalog = await open();
    const updated = await catalog.update("home", {
      label: "Everyday",
      defaultModel: "claude/claude-opus-5-5",
      defaultReasoningEffort: "high",
    });
    expect(updated).toMatchObject({
      label: "Everyday",
      origin: "config",
      settings: {
        defaultModel: "claude/claude-opus-5-5",
        defaultReasoningEffort: "high",
      },
    });
    const cleared = await catalog.update("home", {
      defaultModel: null,
      defaultReasoningEffort: null,
    });
    expect(cleared.settings).toEqual({});
    expect(cleared.label).toBe("Everyday");
    expect((await open()).get("home")?.label).toBe("Everyday");
    await expect(catalog.update("missing", {})).rejects.toMatchObject({
      status: 404,
    });
  });

  it("stores a network policy, defaulting to the open web", async () => {
    const { open } = await setup();
    const catalog = await open();
    expect(projectNetworkPolicy(catalog.get("home"))).toEqual({
      preset: "open",
      allow: [],
    });
    const updated = await catalog.update("home", {
      network: {
        preset: "dependencies",
        allow: [" docs.example.com ", "*.Example.org"],
      },
    });
    expect(projectNetworkPolicy(updated)).toEqual({
      preset: "dependencies",
      allow: ["docs.example.com", "*.example.org"],
    });
    expect(projectNetworkPolicy((await open()).get("home"))).toEqual(
      projectNetworkPolicy(updated),
    );
    await expect(
      catalog.update("home", { network: { preset: "everything", allow: [] } }),
    ).rejects.toBeInstanceOf(ProjectSettingsError);
    await expect(
      catalog.update("home", {
        network: { preset: "open", allow: ["http://bad/"] },
      }),
    ).rejects.toBeInstanceOf(ProjectSettingsError);
    const cleared = await catalog.update("home", {
      network: { preset: "open" },
    });
    expect(projectNetworkPolicy(cleared)).toEqual({
      preset: "open",
      allow: [],
    });
  });

  it("refuses to create projects without projectsRoot", async () => {
    const { open } = await setup();
    const catalog = await open({});
    expect(catalog.canCreate).toBe(false);
    await expect(
      catalog.create({ label: "x", repositories: [] }, fakeClone),
    ).rejects.toMatchObject({ code: "project_creation_disabled" });
  });
});

describe("repository planning", () => {
  it.each([
    "http://github.com/acme/api",
    "git@github.com:acme/api.git",
    "https://user:token@github.com/acme/api",
    "https://github.com/acme/api?x=1",
    "file:///etc",
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => planRepositories([url])).toThrow(HttpError);
  });

  it("derives safe folder names", () => {
    expect(
      planRepositories([
        "https://github.com/acme/My%20Repo.git",
        "https://example.com/",
        "https://example.com/..git",
      ]).map((repository) => repository.directory),
    ).toEqual(["My-20Repo", "repository", "repository-2"]);
  });

  it("slugifies names into project IDs", () => {
    expect(slugifyProjectId("Café Plans!")).toBe("cafe-plans");
    expect(slugifyProjectId("!!!")).toBe("project");
  });
});
