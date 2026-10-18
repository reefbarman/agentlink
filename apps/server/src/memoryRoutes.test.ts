import { afterEach, describe, expect, it } from "vitest";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import { createMemoryRoutes } from "./memoryRoutes.js";
import { promises as fs } from "node:fs";
import http from "node:http";
import { openAssistantMemory } from "./assistantMemory.js";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const auth = (subjectId: string): AssistantServerAuth => {
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
    revalidate: async () => ({ valid: true }),
    detach: () => signedIn,
  };
  return signedIn;
};

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-routes-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const memory = await openAssistantMemory({ directory: dir });
  await memory.instructionsFor({
    sessionId: "chat-1",
    background: false,
    messages: [],
    input: { text: "I live in Brisbane", attachments: undefined },
  });
  const [tool] = memory.tools({
    projectId: "home",
    sessionId: "chat-1",
  }) as unknown as Array<{
    executeValidated(
      input: Record<string, unknown>,
      context: never,
    ): Promise<unknown>;
  }>;
  await tool!.executeValidated(
    {
      statement: "Lives in Brisbane",
      kind: "fact",
      owner_words: "I live in Brisbane",
    },
    {} as never,
  );
  const routes = createMemoryRoutes({
    memory,
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
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    call,
    as: (subjectId: string) => {
      caller = auth(subjectId);
    },
  };
}

describe("memory routes", () => {
  it("lists, edits, exports and forgets memories for the owner only", async () => {
    const { call, as } = await setup();
    const listed = await call("GET", "/api/memory");
    expect(listed.status).toBe(200);
    const [entry] = listed.body.memories;
    expect(entry).toMatchObject({ statement: "Lives in Brisbane" });

    expect(
      (await call("GET", "/api/memory?q=brisbane")).body.memories,
    ).toHaveLength(1);
    expect(
      (await call("GET", "/api/memory?q=sydney")).body.memories,
    ).toHaveLength(0);

    const edited = await call("PATCH", `/api/memory/${entry.id}`, {
      statement: "Lives in Brisbane, Queensland",
      expectedRevision: entry.revision,
    });
    expect(edited.body.memory.statement).toBe("Lives in Brisbane, Queensland");
    expect(
      await call("PATCH", `/api/memory/${entry.id}`, {
        statement: "Elsewhere",
        expectedRevision: entry.revision,
      }),
    ).toEqual({ status: 409, body: { error: "memory_changed" } });

    const exported = await call("GET", "/api/memory/export");
    expect(exported.body.records).toHaveLength(1);

    as("guest");
    expect(await call("GET", "/api/memory")).toEqual({
      status: 403,
      body: { error: "memory_forbidden" },
    });
    as("owner");

    expect(
      (await call("POST", `/api/memory/${entry.id}/forget`, {})).status,
    ).toBe(200);
    expect((await call("GET", "/api/memory")).body.memories).toEqual([]);
    expect(await call("POST", `/api/memory/${entry.id}/forget`, {})).toEqual({
      status: 404,
      body: { error: "memory_not_found" },
    });
  });
});
