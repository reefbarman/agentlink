// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  McpPanel,
  mcpStatusLabel,
  signInReturnNotice,
  type McpServer,
} from "./AssistantMcp";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const server = (patch: Partial<McpServer> = {}): McpServer => ({
  id: "wiki",
  label: "Wiki",
  url: "https://mcp.example.com/mcp",
  auth: "none",
  enabled: true,
  status: "ok",
  origin: "owner",
  hasCredentials: false,
  tools: [
    { name: "search", description: "Search the wiki", policy: "ask" },
    { name: "create", description: "Create a page", policy: "off" },
  ],
  ...patch,
});

function stubFetch(responses: Record<string, unknown>) {
  const calls: Array<{ key: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      calls.push({
        key,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      const body = responses[key];
      return body === undefined
        ? new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

describe("mcpStatusLabel", () => {
  it("says what each state means", () => {
    expect(mcpStatusLabel(server()).text).toBe("Working · 2 tools");
    expect(mcpStatusLabel(server({ enabled: false })).tone).toBe("muted");
    expect(mcpStatusLabel(server({ status: "signed_out" })).text).toBe(
      "Needs you to sign in",
    );
    expect(
      mcpStatusLabel(server({ status: "untested", auth: "oauth" })).text,
    ).toBe("Sign in to finish adding it");
  });
});

describe("signInReturnNotice", () => {
  it("reads the sign-in outcome from the address", () => {
    expect(signInReturnNotice("?mcp=signed-in")).toBe("Signed in.");
    expect(signInReturnNotice("?mcp=sign-in-failed")).toContain("did not");
    expect(signInReturnNotice("")).toBeUndefined();
  });
});

describe("McpPanel", () => {
  it("lists servers and sets a tool's policy", async () => {
    const calls = stubFetch({
      "GET /api/mcp": { servers: [server()] },
      "PUT /api/mcp/wiki/tools/search": { server: server() },
    });
    render(<McpPanel onClose={() => undefined} />);
    await screen.findByText("Wiki");
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    const select = screen.getByLabelText("When search is called");
    fireEvent.change(select, { target: { value: "run" } });
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: "PUT /api/mcp/wiki/tools/search",
        body: { policy: "run" },
      }),
    );
  });

  it("greys out Run for a tool that always asks, and says why", async () => {
    stubFetch({
      "GET /api/mcp": {
        servers: [
          server({
            tools: [
              {
                name: "send_email",
                description: "Send",
                policy: "ask",
                alwaysAsks: "it can send things",
              },
            ],
          }),
        ],
        alwaysAsk: { builtIn: ["names with send"], extra: [] },
      },
    });
    render(<McpPanel onClose={() => undefined} />);
    await screen.findByText("Wiki");
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect(
      screen.getByText("Always asks: it can send things.", { exact: false }),
    ).toBeTruthy();
    const run = screen.getByRole("option", {
      name: "Run",
    }) as HTMLOptionElement;
    expect(run.disabled).toBe(true);
  });

  it("limits Run to some argument values", async () => {
    const calls = stubFetch({
      "GET /api/mcp": {
        servers: [
          server({
            tools: [
              {
                name: "list_events",
                description: "List events",
                policy: "run",
                arguments: ["calendarId", "timeMin"],
              },
            ],
          }),
        ],
      },
      "PUT /api/mcp/wiki/tools/list_events": { server: server() },
    });
    render(<McpPanel onClose={() => undefined} />);
    await screen.findByText("Wiki");
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect(screen.getByText(/Runs for every call/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    fireEvent.input(screen.getByLabelText("is one of"), {
      target: { value: "primary, family*" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save limit" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: "PUT /api/mcp/wiki/tools/list_events",
        body: {
          policy: "run",
          runWhen: { calendarId: ["primary", "family*"] },
        },
      }),
    );
  });

  it("adds the owner's entries to the always-ask list", async () => {
    const calls = stubFetch({
      "GET /api/mcp": {
        servers: [server()],
        alwaysAsk: { builtIn: ["names with send"], extra: [] },
      },
      "PUT /api/mcp": {
        servers: [server()],
        alwaysAsk: { builtIn: ["names with send"], extra: ["create_*"] },
      },
    });
    render(<McpPanel onClose={() => undefined} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Add to the list" }),
    );
    fireEvent.input(screen.getByLabelText("Your always-ask entries"), {
      target: { value: "create_*\n\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: "PUT /api/mcp",
        body: { alwaysAsk: ["create_*"] },
      }),
    );
  });

  it("adds a server on the owner's network, with Home Assistant setup help", async () => {
    const calls = stubFetch({
      "GET /api/mcp": { servers: [] },
      "POST /api/mcp": { server: server({ auth: "header", network: true }) },
    });
    render(<McpPanel onClose={() => undefined} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Add a server/ }),
    );
    fireEvent.click(screen.getByLabelText(/On my network/));
    expect(screen.getByText(/Require an administrator account/)).toBeTruthy();
    const oauth = screen.getByLabelText(
      /Sign in with the service/,
    ) as HTMLInputElement;
    expect(oauth.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText("Name"), {
      target: { value: "Home Assistant" },
    });
    fireEvent.input(screen.getByLabelText("Address"), {
      target: { value: "http://192.168.1.20:8123/api/mcp" },
    });
    fireEvent.click(screen.getByLabelText(/An API key in a header/));
    fireEvent.input(screen.getByLabelText("Value"), {
      target: { value: "Bearer t" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: "POST /api/mcp",
        body: {
          label: "Home Assistant",
          url: "http://192.168.1.20:8123/api/mcp",
          auth: "header",
          headerName: "Authorization",
          headerValue: "Bearer t",
          network: true,
        },
      }),
    );
  });

  it("opens the service's sign-in page", async () => {
    stubFetch({
      "GET /api/mcp": {
        servers: [server({ auth: "oauth", status: "untested", tools: [] })],
      },
      "POST /api/mcp/wiki/sign-in": {
        authorizationUrl: "https://auth.example.com/authorize?state=x",
      },
    });
    const openUrl = vi.fn();
    render(<McpPanel onClose={() => undefined} openUrl={openUrl} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(
        "https://auth.example.com/authorize?state=x",
      ),
    );
  });

  it("adds a server with a header secret", async () => {
    const calls = stubFetch({
      "GET /api/mcp": { servers: [] },
      "POST /api/mcp": { server: server({ auth: "header" }) },
    });
    render(<McpPanel onClose={() => undefined} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Add a server/ }),
    );
    fireEvent.input(screen.getByLabelText("Name"), {
      target: { value: "Wiki" },
    });
    fireEvent.input(screen.getByLabelText("Address"), {
      target: { value: "https://mcp.example.com/mcp" },
    });
    fireEvent.click(screen.getByLabelText(/An API key in a header/));
    fireEvent.input(screen.getByLabelText("Value"), {
      target: { value: "Bearer k" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        key: "POST /api/mcp",
        body: {
          label: "Wiki",
          url: "https://mcp.example.com/mcp",
          auth: "header",
          headerName: "Authorization",
          headerValue: "Bearer k",
        },
      }),
    );
    await screen.findByText(/Every tool asks you first/);
  });
});
