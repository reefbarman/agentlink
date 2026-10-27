import { DEFAULT_PERSONA_TEXT, openPersonaStore } from "./persona.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError } from "./httpJson.js";
import { createPersonaRoutes } from "./personaRoutes.js";
import { promises as fs } from "node:fs";
import http from "node:http";
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "persona-routes-"));
  cleanup.push(() =>
    fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  );
  const store = await openPersonaStore({
    file: path.join(dir, "persona.json"),
    defaultTimeZone: "Australia/Brisbane",
  });
  const onChanged = vi.fn();
  const routes = createPersonaRoutes({
    store,
    isOwner: (request) => request.principal.subjectId === "owner",
    onChanged,
    now: () => 77,
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
  const call = async (method: string, body?: unknown) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/settings/persona`,
      {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  return {
    store,
    onChanged,
    call,
    as: (subjectId: string) => {
      caller = auth(subjectId);
    },
  };
}

describe("persona routes", () => {
  it("shows the settings and the default persona to the owner only", async () => {
    const { call, as } = await setup();
    const shown = await call("GET");
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({
      settings: { timeZone: "Australia/Brisbane", updatedAt: 0 },
      defaultPersona: DEFAULT_PERSONA_TEXT,
    });
    as("guest");
    expect(await call("GET")).toEqual({
      status: 403,
      body: { error: "settings_forbidden" },
    });
  });

  it("saves a change made from the current settings", async () => {
    const { call, onChanged, store } = await setup();
    const saved = await call("PATCH", {
      expectedUpdatedAt: 0,
      name: "Matey",
      quietHours: null,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toMatchObject({ name: "Matey", updatedAt: 77 });
    expect(saved.body.settings.quietHours).toBeUndefined();
    expect(store.get().name).toBe("Matey");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("refuses a change made from stale settings, and invalid fields", async () => {
    const { call, store } = await setup();
    await store.update({ name: "Elsewhere" }, 10);
    expect(
      await call("PATCH", { expectedUpdatedAt: 0, name: "Matey" }),
    ).toEqual({ status: 409, body: { error: "settings_changed" } });
    expect(await call("PATCH", { timeZone: "Mars/Olympus" })).toEqual({
      status: 400,
      body: { error: "persona_time_zone_invalid" },
    });
    expect(store.get().name).toBe("Elsewhere");
  });
});
