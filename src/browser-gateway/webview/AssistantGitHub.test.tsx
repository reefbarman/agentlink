import {
  GitHubPanel,
  connectionStatusLabel,
  filterRepositories,
  parseCommands,
} from "./AssistantGitHub";
import { afterEach, describe, expect, it, vi } from "vitest";
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Route = (body: unknown) => unknown;

/** A fetch stub answering `METHOD path` routes; records every call. */
function stubFetch(routes: Record<string, Route>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url, body });
    const route = routes[`${method} ${url}`];
    if (!route) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(route(body)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const CONNECTION = {
  id: "conn-1",
  kind: "app" as const,
  login: "octocat",
  commitName: "Mona Octocat",
  commitEmail: "mona@example.com",
};

const configured = (connections: unknown[] = []) => ({
  configured: true,
  available: true,
  deviceFlow: true,
  connections,
});

describe("GitHub helpers", () => {
  it("labels connection states for the owner", () => {
    expect(
      connectionStatusLabel({
        status: "connected",
        kind: "app",
        login: "octocat",
        signedIn: true,
      }),
    ).toEqual({ text: "Signed in as @octocat", tone: "ok" });
    expect(connectionStatusLabel({ status: "expired" }).tone).toBe("warn");
    expect(
      connectionStatusLabel({ status: "unavailable", error: "down" }).text,
    ).toBe("Publisher not reachable");
  });

  it("parses one command per line", () => {
    expect(parseCommands("  npm ci \n\n npm test\n")).toEqual([
      "npm ci",
      "npm test",
    ]);
  });
});

describe("GitHubPanel", () => {
  it("explains when publishing is not set up", async () => {
    stubFetch({
      "GET /api/github": () => ({
        configured: false,
        available: false,
        deviceFlow: false,
        connections: [],
      }),
      "GET /api/tasks/repositories": () => ({ repositories: [] }),
    });
    render(<GitHubPanel onClose={() => undefined} />);
    expect(
      await screen.findByText(/Publishing is not set up on this server/u),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: /Connect GitHub/u,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("lists connections and repositories with their permission", async () => {
    stubFetch({
      "GET /api/github": () =>
        configured([
          {
            connection: CONNECTION,
            status: {
              status: "connected",
              kind: "app",
              login: "octocat",
              signedIn: true,
            },
          },
        ]),
      "GET /api/tasks/repositories": () => ({
        repositories: [
          {
            repository: "https://github.com/octocat/hello-world",
            validation: ["npm test"],
            publish: { connectionId: "conn-1", grantedAt: 1 },
          },
        ],
      }),
    });
    render(<GitHubPanel onClose={() => undefined} />);
    expect(await screen.findByText("Signed in as @octocat")).toBeTruthy();
    expect(screen.getByText("github.com/octocat/hello-world")).toBeTruthy();
    expect(
      screen.getByText(
        /1 validation command · Publishes draft PRs as @octocat/u,
      ),
    ).toBeTruthy();
  });

  it("lists the repositories the connections reach, and refreshes them", async () => {
    const reachable = (names: string[]) => ({
      publisherConfigured: true,
      connections: [
        { id: "conn-1", login: "octocat", status: "ok", repositories: 1 },
        {
          id: "conn-2",
          login: "work",
          status: "failed",
          error: "connection_signed_out",
          repositories: 0,
        },
      ],
      repositories: names.map((fullName) => ({
        repository: `https://github.com/${fullName}`,
        fullName,
        private: true,
        description: "My website",
        connectionIds: ["conn-1"],
      })),
    });
    const calls = stubFetch({
      "GET /api/github": () =>
        configured([
          {
            connection: CONNECTION,
            status: {
              status: "connected",
              kind: "app",
              login: "octocat",
              signedIn: true,
            },
          },
        ]),
      "GET /api/tasks/repositories": () => ({ repositories: [] }),
      "GET /api/github/repositories": () => reachable([]),
      "GET /api/github/repositories?refresh=1": () =>
        reachable(["octocat/site"]),
    });
    render(<GitHubPanel onClose={() => undefined} />);
    expect(await screen.findByText(/Choose which ones at/u)).toBeTruthy();
    expect(screen.getByText(/@work/u).textContent).toContain("signed out");
    fireEvent.click(screen.getByText("Refresh"));
    expect(await screen.findByText("octocat/site")).toBeTruthy();
    expect(screen.getByText(/Private · @octocat · My website/u)).toBeTruthy();
    expect(calls.map((call) => call.path)).toContain(
      "/api/github/repositories?refresh=1",
    );
  });

  it("filters reachable repositories by every word", () => {
    const entry = (fullName: string, description?: string) => ({
      repository: `https://github.com/${fullName}`,
      fullName,
      connectionIds: ["c"],
      ...(description ? { description } : {}),
    });
    const all = [
      entry("reefbarman/agentlink"),
      entry("reefbarman/tristancartledge.com", "Personal website"),
    ];
    expect(
      filterRepositories(all, "reef website").map((item) => item.fullName),
    ).toEqual(["reefbarman/tristancartledge.com"]);
    expect(filterRepositories(all, "")).toHaveLength(2);
  });

  it("shows the device code and follows the sign-in until it completes", async () => {
    let polled = 0;
    const calls = stubFetch({
      "GET /api/github": () => configured(),
      "GET /api/tasks/repositories": () => ({ repositories: [] }),
      "POST /api/github/connections": () => ({
        connection: { ...CONNECTION, login: undefined },
        status: {
          status: "pending",
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          expiresAt: Date.now() + 900_000,
        },
      }),
      "GET /api/github/connections/conn-1": () => {
        polled += 1;
        return polled < 2
          ? {
              status: {
                status: "pending",
                userCode: "ABCD-1234",
                verificationUri: "https://github.com/login/device",
                expiresAt: Date.now() + 900_000,
              },
            }
          : {
              status: {
                status: "connected",
                kind: "app",
                login: "octocat",
                signedIn: true,
              },
            };
      },
    });
    render(<GitHubPanel onClose={() => undefined} pollMs={10} />);
    await screen.findByText(/No GitHub accounts yet/u);
    fireEvent.click(screen.getByRole("button", { name: /Connect GitHub/u }));
    fireEvent.input(screen.getByLabelText("Name"), {
      target: { value: "Mona Octocat" },
    });
    fireEvent.input(screen.getByLabelText("Email"), {
      target: { value: "mona@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Get a code" }));

    expect(await screen.findByLabelText("GitHub code")).toBeTruthy();
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      method: "device",
      commitName: "Mona Octocat",
      commitEmail: "mona@example.com",
    });

    expect(await screen.findByText("Connected as @octocat.")).toBeTruthy();
    expect(screen.queryByLabelText("GitHub code")).toBeNull();
  });

  it("connects with a fine-grained token without keeping it on the page", async () => {
    const calls = stubFetch({
      "GET /api/github": () => configured(),
      "GET /api/tasks/repositories": () => ({ repositories: [] }),
      "POST /api/github/connections": () => ({
        connection: { ...CONNECTION, kind: "token" },
        status: {
          status: "connected",
          kind: "token",
          login: "octocat",
          signedIn: true,
        },
      }),
    });
    render(<GitHubPanel onClose={() => undefined} />);
    await screen.findByText(/No GitHub accounts yet/u);
    fireEvent.click(screen.getByRole("button", { name: /Connect GitHub/u }));
    fireEvent.input(screen.getByLabelText("Name"), {
      target: { value: "Mona Octocat" },
    });
    fireEvent.input(screen.getByLabelText("Email"), {
      target: { value: "mona@example.com" },
    });
    fireEvent.click(screen.getByLabelText(/Fine-grained token/u));
    fireEvent.input(screen.getByLabelText("Token"), {
      target: { value: "github_pat_secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Connected as @octocat.")).toBeTruthy();
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      method: "token",
      token: "github_pat_secret",
    });
    expect(document.body.innerHTML).not.toContain("github_pat_secret");
  });

  it("saves a repository's validation commands and publishing connection", async () => {
    const calls = stubFetch({
      "GET /api/github": () =>
        configured([
          {
            connection: CONNECTION,
            status: {
              status: "connected",
              kind: "app",
              login: "octocat",
              signedIn: true,
            },
          },
        ]),
      "GET /api/tasks/repositories": () => ({ repositories: [] }),
      "PUT /api/tasks/repositories": (body) => ({ repository: body }),
    });
    render(<GitHubPanel onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: /Add$/u }));
    fireEvent.input(
      screen.getByPlaceholderText("https://github.com/you/repo"),
      { target: { value: " https://github.com/octocat/hello-world " } },
    );
    fireEvent.input(screen.getByRole("textbox", { name: /Validation/u }), {
      target: { value: "npm ci\n\nnpm test" },
    });
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "conn-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
        repository: "https://github.com/octocat/hello-world",
        validation: ["npm ci", "npm test"],
        connectionId: "conn-1",
      }),
    );
  });
});
