import { HttpError, sendJson } from "./httpJson.js";
import { PROJECT_COOKIE, createProjectChats } from "./projectChats.js";
import { ProjectCloneError, openProjectCatalog } from "./projectCatalog.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AskAgentBridge } from "./askAgentBridge.js";
import type { AssistantServerAuth } from "./assistantServer.js";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A bridge that answers every request with its project ID. */
function fakeBridge(projectId: string): AskAgentBridge {
  return {
    theme: {} as AskAgentBridge["theme"],
    activity: () =>
      projectId === "work"
        ? { running: 1, needsYou: 0, unread: 2 }
        : { running: 0, needsYou: 0, unread: 0 },
    handleRequest: vi.fn(async (request, response) => {
      const url = new URL(request.url ?? "/", "https://x.invalid");
      if (!url.pathname.startsWith("/api/ask-agent/")) return false;
      request.resume();
      sendJson(response, 200, { projectId, path: url.pathname });
      return true;
    }),
    close: vi.fn(async () => undefined),
  };
}

async function setup(options: { clone?: boolean; valid?: boolean } = {}) {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "project-chats-")),
  );
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const work = path.join(dir, "work");
  await fs.mkdir(home);
  await fs.mkdir(work);
  const catalog = await openProjectCatalog({
    file: path.join(dir, "projects.json"),
    configProjects: [
      { id: "home", label: "Home", root: home },
      { id: "work", label: "Work", root: work },
    ],
    projectsRoot: path.join(dir, "projects"),
  });
  const clone = vi.fn(
    async ({ cwd, directory }: { cwd: string; directory: string }) => {
      if (directory === "missing") {
        throw new ProjectCloneError(
          "https://github.com/acme/missing",
          "fatal: repository not found",
        );
      }
      await fs.mkdir(path.join(cwd, directory));
    },
  );
  const opened: string[] = [];
  const chats = createProjectChats({
    catalog,
    bridges: new Map([
      ["home", fakeBridge("home")],
      ["work", fakeBridge("work")],
    ]),
    models: [
      { providerId: "codex", modelId: "gpt" },
      { providerId: "claude", modelId: "opus" },
    ],
    ...(options.clone === false ? {} : { clone }),
    openProject: async (entry) => {
      opened.push(entry.id);
      return fakeBridge(entry.id);
    },
  });
  const auth: AssistantServerAuth = {
    principal: { tenantId: "agentlink-server", subjectId: "owner" },
    session: {
      ownerId: "owner",
      sessionId: "s",
      deviceId: "d",
      deviceLabel: "Laptop",
      createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
    signal: new AbortController().signal,
    revalidate: async () => ({ valid: options.valid ?? true }),
    detach: () => auth,
  };
  const server = http.createServer((request, response) => {
    chats
      .handleRequest(request, response, auth)
      .then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      })
      .catch((error: unknown) => {
        response.writeHead(error instanceof HttpError ? error.status : 500, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            error: error instanceof HttpError ? error.code : String(error),
          }),
        );
      });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as { port: number }).port;
  cleanup.push(async () => {
    await chats.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const call = async (
    route: string,
    init: { body?: unknown; cookie?: string } = {},
  ) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: init.body === undefined ? "GET" : "POST",
      headers: {
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return {
      status: response.status,
      setCookie: response.headers.get("set-cookie"),
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return { call, catalog, clone, opened, home, chats };
}

describe("project chats", () => {
  it("routes chat requests to the project this browser selected", async () => {
    const { call } = await setup();
    expect((await call("/api/ask-agent/session")).body.projectId).toBe("home");

    const selected = await call("/api/ask-agent/projects/select", {
      body: { projectId: "work" },
    });
    expect(selected.status).toBe(200);
    expect(selected.setCookie).toBe(
      `${PROJECT_COOKIE}=work; Path=/; Max-Age=34560000; Secure; HttpOnly; SameSite=Strict`,
    );
    expect(selected.body.activeProjectId).toBe("work");

    const cookie = `other=1; ${PROJECT_COOKIE}=work`;
    expect(
      (await call("/api/ask-agent/session", { cookie })).body.projectId,
    ).toBe("work");
    const listed = await call("/api/ask-agent/projects", { cookie });
    expect(listed.body).toMatchObject({
      activeProjectId: "work",
      canCreate: true,
      canClone: true,
      projects: [
        { id: "home", activity: { running: 0, needsYou: 0, unread: 0 } },
        { id: "work", activity: { running: 1, needsYou: 0, unread: 2 } },
      ],
    });
    // Unknown or stale selections fall back to the first project.
    expect(
      (
        await call("/api/ask-agent/session", {
          cookie: `${PROJECT_COOKIE}=gone`,
        })
      ).body.projectId,
    ).toBe("home");
    expect(
      (
        await call("/api/ask-agent/projects/select", {
          body: { projectId: "gone" },
        })
      ).status,
    ).toBe(404);
  });

  it("creates a cloned project, opens it, and selects it", async () => {
    const { call, clone, opened } = await setup();
    const created = await call("/api/ask-agent/projects", {
      body: {
        name: "Side project",
        repositories: ["https://github.com/acme/api", " "],
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.project).toMatchObject({
      id: "side-project",
      label: "Side project",
      origin: "app",
      repositories: [{ url: "https://github.com/acme/api", directory: "api" }],
    });
    expect(clone).toHaveBeenCalledTimes(1);
    expect(opened).toEqual(["side-project"]);
    expect(created.setCookie).toContain(`${PROJECT_COOKIE}=side-project;`);
    expect(
      (
        await call("/api/ask-agent/send", {
          body: {},
          cookie: `${PROJECT_COOKIE}=side-project`,
        })
      ).body.projectId,
    ).toBe("side-project");
  });

  it("reports clone failures with git's output", async () => {
    const { call, opened } = await setup();
    const failed = await call("/api/ask-agent/projects", {
      body: {
        name: "Broken",
        repositories: ["https://github.com/acme/missing"],
      },
    });
    expect(failed.status).toBe(422);
    expect(failed.body).toEqual({
      error: "project_clone_failed",
      url: "https://github.com/acme/missing",
      detail: "fatal: repository not found",
    });
    expect(opened).toEqual([]);
  });

  it("rejects cloning without a cloner and creation after sign-out", async () => {
    const withoutClone = await setup({ clone: false });
    expect(
      (
        await withoutClone.call("/api/ask-agent/projects", {
          body: { name: "x", repositories: ["https://github.com/a/b"] },
        })
      ).status,
    ).toBe(409);
    const signedOut = await setup({ valid: false });
    expect(
      (
        await signedOut.call("/api/ask-agent/projects", {
          body: { name: "x" },
        })
      ).status,
    ).toBe(401);
  });

  it("reads and saves settings, including AGENTS.md", async () => {
    const { call, home, catalog } = await setup();
    const empty = await call("/api/ask-agent/projects/home/settings");
    expect(empty.body).toMatchObject({
      instructions: "",
      instructionsTruncated: false,
      project: { id: "home", label: "Home", path: home },
    });

    const saved = await call("/api/ask-agent/projects/home/settings", {
      body: {
        name: "Everyday",
        defaultModel: "claude/opus",
        defaultReasoningEffort: "high",
        instructions: "Answer briefly.",
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      instructions: "Answer briefly.\n",
      project: {
        label: "Everyday",
        settings: {
          defaultModel: "claude/opus",
          defaultReasoningEffort: "high",
        },
      },
    });
    await expect(
      fs.readFile(path.join(home, "AGENTS.md"), "utf8"),
    ).resolves.toBe("Answer briefly.\n");
    expect(catalog.get("home")?.label).toBe("Everyday");

    // Clearing removes the file and the defaults.
    const cleared = await call("/api/ask-agent/projects/home/settings", {
      body: {
        defaultModel: null,
        defaultReasoningEffort: "",
        instructions: "  ",
      },
    });
    expect(cleared.body).toMatchObject({
      instructions: "",
      project: { settings: {} },
    });
    await expect(fs.access(path.join(home, "AGENTS.md"))).rejects.toThrow();

    expect(
      (
        await call("/api/ask-agent/projects/home/settings", {
          body: { defaultModel: "nope/nope" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("/api/ask-agent/projects/home/settings", {
          body: { defaultReasoningEffort: "extreme" },
        })
      ).status,
    ).toBe(400);
    expect((await call("/api/ask-agent/projects/nope/settings")).status).toBe(
      404,
    );
  });

  it("saves network settings and explains invalid sites", async () => {
    const { call, catalog } = await setup();
    const saved = await call("/api/ask-agent/projects/home/settings", {
      body: {
        network: { preset: "dependencies", allow: ["docs.example.com"] },
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      project: {
        settings: {
          network: { preset: "dependencies", allow: ["docs.example.com"] },
        },
      },
    });
    expect(catalog.get("home")?.settings.network?.preset).toBe("dependencies");
    const invalid = await call("/api/ask-agent/projects/home/settings", {
      body: { network: { preset: "open", allow: ["http://bad/"] } },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      error: "network_allow_invalid",
      detail: expect.stringContaining("http://bad/"),
    });
    expect(
      (
        await call("/api/ask-agent/projects/home/settings", {
          body: { network: { preset: "everything" } },
        })
      ).status,
    ).toBe(400);
  });

  it("serves files from the selected project to the file viewer", async () => {
    const { call, home } = await setup();
    const work = path.join(path.dirname(home), "work");
    await fs.writeFile(path.join(home, "notes.md"), "home notes");
    await fs.writeFile(path.join(work, "notes.md"), "work notes");

    const homeFile = await call("/api/ask-agent/project-file?path=notes.md");
    expect(homeFile).toMatchObject({
      status: 200,
      body: {
        projectId: "home",
        path: "notes.md",
        content: "home notes",
        truncated: false,
      },
    });
    const workFile = await call(
      `/api/ask-agent/project-file?path=${encodeURIComponent(path.join(work, "notes.md"))}`,
      { cookie: `${PROJECT_COOKIE}=work` },
    );
    expect(workFile.body).toMatchObject({
      projectId: "work",
      content: "work notes",
    });
    // The other project's files are outside the selected project.
    expect(
      (
        await call(
          `/api/ask-agent/project-file?path=${encodeURIComponent(path.join(work, "notes.md"))}`,
        )
      ).body,
    ).toEqual({ error: "outside_project" });
    expect(
      (await call("/api/ask-agent/project-file?path=missing.md")).status,
    ).toBe(404);
    expect(
      (await call("/api/ask-agent/project-file", { body: {} })).status,
    ).toBe(405);
  });

  it("closes every project's bridge", async () => {
    const { call, chats } = await setup();
    await call("/api/ask-agent/projects", { body: { name: "Extra" } });
    await chats.close();
    expect(
      (await call("/api/ask-agent/projects", { body: { name: "Late" } }))
        .status,
    ).toBe(503);
  });
});
