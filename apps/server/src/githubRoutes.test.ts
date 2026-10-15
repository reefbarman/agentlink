import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantServerAuth } from "./assistantServer.js";
import {
  openGitHubConnections,
  parseCommitIdentity,
} from "./githubConnections.js";
import { createRepositoryDirectory } from "./githubRepositories.js";
import { createGitHubRoutes } from "./githubRoutes.js";
import { HttpError } from "./httpJson.js";
import type { ConnectionStatus } from "./publisher.js";
import {
  PublisherRequestError,
  type PublisherClient,
} from "./publisherClient.js";
import { openRepositorySettings } from "./taskRepositories.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const auth = (subjectId: string, valid = true): AssistantServerAuth => {
  const signedIn: AssistantServerAuth = {
    principal: { tenantId: "agentlink-server", subjectId },
    session: {
      ownerId: subjectId,
      sessionId: "s",
      deviceId: "d",
      deviceLabel: "Laptop",
      createdAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
    signal: new AbortController().signal,
    revalidate: async () => ({ valid }),
    detach: () => signedIn,
  };
  return signedIn;
};

const IDENTITY = {
  commitName: "Tristan",
  commitEmail: "tristan@example.com",
};

function fakePublisher() {
  const statuses = new Map<string, ConnectionStatus>();
  const publisher = {
    health: vi.fn(async () => ({ protocol: 1, deviceFlow: true })),
    startDeviceFlow: vi.fn(async (id: string): Promise<ConnectionStatus> => {
      const status: ConnectionStatus = {
        status: "pending",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresAt: 900_000,
      };
      statuses.set(id, status);
      return status;
    }),
    status: vi.fn(
      async (id: string): Promise<ConnectionStatus> =>
        statuses.get(id) ?? { status: "missing" },
    ),
    importToken: vi.fn(
      async (id: string, token: string): Promise<ConnectionStatus> => {
        if (token !== "github_pat_good0123456789") {
          throw new PublisherRequestError(
            400,
            "token_rejected",
            "Bad credentials",
          );
        }
        const status: ConnectionStatus = {
          status: "connected",
          kind: "token",
          login: "reefbarman",
          signedIn: true,
        };
        statuses.set(id, status);
        return status;
      },
    ),
    remove: vi.fn(async (id: string) => statuses.delete(id)),
    repositories: vi.fn(async (_id: string) => ({
      login: "reefbarman",
      repositories: [
        {
          owner: "reefbarman",
          name: "site",
          private: true,
          archived: false,
        },
      ],
      truncated: false,
    })),
    publish: vi.fn(),
    snapshot: vi.fn(),
  } satisfies PublisherClient;
  return { publisher, statuses };
}

async function setup(options: { readonly publisher?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "github-routes-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const connections = await openGitHubConnections({
    file: path.join(dir, "connections.json"),
  });
  const repositories = await openRepositorySettings({
    file: path.join(dir, "repositories.json"),
  });
  const fake = fakePublisher();
  const publisher = options.publisher === false ? undefined : fake.publisher;
  const directory = createRepositoryDirectory({
    connections,
    publisher,
    settings: repositories,
  });
  const routes = createGitHubRoutes({
    connections,
    publisher,
    repositories,
    directory,
    isOwner: (request) => request.principal.subjectId === "owner",
  });
  let caller = auth("owner");
  const server = http.createServer((request, response) => {
    routes
      .handleRequest(request, response, caller)
      .then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end("{}");
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
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return {
    ...fake,
    connections,
    repositories,
    call,
    setCaller(next: AssistantServerAuth) {
      caller = next;
    },
  };
}

describe("GitHub routes", () => {
  it("connects with a device code and records the account when signed in", async () => {
    const test = await setup();
    const created = await test.call("POST", "/api/github/connections", {
      method: "device",
      ...IDENTITY,
    });
    expect(created).toMatchObject({
      status: 201,
      body: {
        connection: { kind: "app", ...IDENTITY },
        status: { status: "pending", userCode: "ABCD-1234" },
      },
    });
    const id = (created.body.connection as { id: string }).id;
    // The owner approves the code on GitHub; the publisher learns the token.
    test.statuses.set(id, {
      status: "connected",
      kind: "app",
      login: "reefbarman",
      signedIn: true,
    });
    await expect(
      test.call("GET", `/api/github/connections/${id}`),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        connection: { id, login: "reefbarman" },
        status: { status: "connected" },
      },
    });
    expect(test.connections.get(id)?.login).toBe("reefbarman");
    await expect(test.call("GET", "/api/github")).resolves.toMatchObject({
      body: {
        configured: true,
        available: true,
        deviceFlow: true,
        connections: [{ connection: { id }, status: { status: "connected" } }],
      },
    });
  });

  it("connects with a token, and forgets a connection whose token is refused", async () => {
    const test = await setup();
    await expect(
      test.call("POST", "/api/github/connections", {
        method: "token",
        ...IDENTITY,
        token: "github_pat_bad",
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "token_rejected", detail: "Bad credentials" },
    });
    expect(test.connections.list()).toEqual([]);
    const created = await test.call("POST", "/api/github/connections", {
      method: "token",
      ...IDENTITY,
      token: "github_pat_good0123456789",
    });
    expect(created).toMatchObject({
      status: 201,
      body: { connection: { kind: "token", login: "reefbarman" } },
    });
    // The token itself is never stored or returned by the server.
    expect(JSON.stringify(created.body)).not.toContain("github_pat_good");
    expect(JSON.stringify(test.connections.list())).not.toContain("github_pat");
  });

  it("edits the commit identity and revokes permissions on removal", async () => {
    const test = await setup();
    const connection = await test.connections.create("app", IDENTITY, 1);
    await test.repositories.setPublish(
      "https://github.com/reefbarman/demo",
      connection.id,
      1,
    );
    await expect(
      test.call("PATCH", `/api/github/connections/${connection.id}`, {
        commitEmail: "not an email",
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "commit_email_invalid" },
    });
    await expect(
      test.call("PATCH", `/api/github/connections/${connection.id}`, {
        commitEmail: "me@example.org",
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { connection: { commitEmail: "me@example.org" } },
    });
    expect(
      (await test.call("DELETE", `/api/github/connections/${connection.id}`))
        .status,
    ).toBe(200);
    expect(test.publisher.remove).toHaveBeenCalledWith(connection.id);
    expect(test.connections.get(connection.id)).toBeUndefined();
    expect(test.repositories.get("https://github.com/reefbarman/demo")).toBe(
      undefined,
    );
  });

  it("refuses other people, stale sign-ins and a missing publisher", async () => {
    const test = await setup();
    test.setCaller(auth("guest"));
    await expect(test.call("GET", "/api/github")).resolves.toMatchObject({
      status: 403,
    });
    test.setCaller(auth("owner", false));
    await expect(
      test.call("POST", "/api/github/connections", {
        method: "device",
        ...IDENTITY,
      }),
    ).resolves.toMatchObject({ status: 401 });
    expect(test.publisher.startDeviceFlow).not.toHaveBeenCalled();

    const without = await setup({ publisher: false });
    await expect(without.call("GET", "/api/github")).resolves.toMatchObject({
      body: { configured: false, available: false, connections: [] },
    });
    await expect(
      without.call("POST", "/api/github/connections", {
        method: "device",
        ...IDENTITY,
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: "publisher_not_configured" },
    });
  });

  it("lists reachable repositories, cached until refreshed or a connection changes", async () => {
    const test = await setup();
    const connection = await test.connections.create("app", IDENTITY, 1);
    const listed = await test.call("GET", "/api/github/repositories");
    expect(listed).toMatchObject({
      status: 200,
      body: {
        publisherConfigured: true,
        connections: [{ id: connection.id, status: "ok", repositories: 1 }],
        repositories: [
          {
            repository: "https://github.com/reefbarman/site",
            fullName: "reefbarman/site",
            private: true,
            connectionIds: [connection.id],
          },
        ],
      },
    });
    await test.call("GET", "/api/github/repositories");
    expect(test.publisher.repositories).toHaveBeenCalledOnce();
    await test.call("GET", "/api/github/repositories?refresh=1");
    expect(test.publisher.repositories).toHaveBeenCalledTimes(2);
    await test.call("DELETE", `/api/github/connections/${connection.id}`);
    await expect(
      test.call("GET", "/api/github/repositories"),
    ).resolves.toMatchObject({ body: { connections: [], repositories: [] } });

    test.setCaller(auth("guest"));
    await expect(
      test.call("GET", "/api/github/repositories"),
    ).resolves.toMatchObject({ status: 403 });
  });
});

describe("commit identity", () => {
  it("accepts a name and email, and refuses what would break a trailer", () => {
    expect(
      parseCommitIdentity({
        commitName: " Tristan ",
        commitEmail: "t@example.com",
      }),
    ).toEqual({ commitName: "Tristan", commitEmail: "t@example.com" });
    expect(() =>
      parseCommitIdentity({ commitName: "A <b>", commitEmail: "t@e.com" }),
    ).toThrow("commit_name_invalid");
    expect(() =>
      parseCommitIdentity({ commitName: "A\nB", commitEmail: "t@e.com" }),
    ).toThrow("commit_name_invalid");
    expect(() =>
      parseCommitIdentity({ commitName: "A", commitEmail: "t@e.com>x" }),
    ).toThrow("commit_email_invalid");
  });
});
