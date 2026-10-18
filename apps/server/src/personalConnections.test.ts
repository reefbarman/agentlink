import type { McpServerRecord, McpToolRecord } from "./mcpRegistry.js";
import { describe, expect, it } from "vitest";

import { alwaysAskReason } from "./mcpToolGuard.js";
import { personalConnection } from "./personalConnections.js";

const tool = (
  name: string,
  policy: McpToolRecord["policy"] = "run",
  extra: Partial<McpToolRecord> = {},
): McpToolRecord => ({
  name,
  description: "",
  inputSchema: { type: "object", properties: {} },
  schemaHash: "h",
  policy,
  ...extra,
});

const server = (
  id: string,
  label: string,
  tools: McpToolRecord[],
  extra: Partial<McpServerRecord> = {},
): McpServerRecord => ({
  id,
  label,
  url: `https://${id}.example.com/mcp`,
  auth: "oauth",
  enabled: true,
  status: "ok",
  tools,
  origin: "owner",
  createdAt: 0,
  ...extra,
});

const refusal =
  (servers: readonly McpServerRecord[]) => (id: string, name: string) => {
    const found = servers
      .find((candidate) => candidate.id === id)
      ?.tools.find((candidate) => candidate.name === name);
    return found ? alwaysAskReason(id, found) : undefined;
  };

const connect = (servers: McpServerRecord[], area: "calendar" | "email") =>
  personalConnection(servers, area, refusal(servers));

describe("personalConnection", () => {
  it("finds Run read tools for calendar and email on a Google server", () => {
    const servers = [
      server("google", "Google Workspace", [
        tool("list_events", "run", { runWhen: { calendarId: ["primary"] } }),
        tool("create_event", "ask"),
        tool("search_messages"),
        tool("send_email", "ask"),
      ]),
    ];
    expect(connect(servers, "calendar")).toEqual({
      state: "ready",
      tools: [
        {
          server: "google",
          serverLabel: "Google Workspace",
          tool: "list_events",
          rule: "calendarId is primary",
        },
      ],
    });
    expect(connect(servers, "email")).toMatchObject({
      state: "ready",
      tools: [{ tool: "search_messages" }],
    });
  });

  it("does not take a chat app's messages for email", () => {
    const servers = [server("slack", "Slack", [tool("search_messages")])];
    expect(connect(servers, "email")).toEqual({ state: "not_connected" });
    // Its own name is enough on any server.
    const gmail = [server("tools", "Tools", [tool("gmail_search")])];
    expect(connect(gmail, "email").state).toBe("ready");
  });

  it("reports read tools that still ask, and signed-out or turned-off servers", () => {
    expect(
      connect(
        [server("google", "Google", [tool("list_events", "ask")])],
        "calendar",
      ).state,
    ).toBe("asks");
    expect(
      connect(
        [
          server("google", "Google", [tool("list_events")], {
            status: "signed_out",
          }),
        ],
        "calendar",
      ),
    ).toEqual({ state: "needs_attention", serverLabel: "Google" });
    expect(
      connect(
        [server("google", "Google", [tool("list_events")], { enabled: false })],
        "calendar",
      ).state,
    ).toBe("not_connected");
    // Off tools and always-ask tools never count.
    expect(
      connect(
        [
          server("google", "Google", [
            tool("list_events", "off"),
            tool("list_events_destructive", "run", { destructiveHint: true }),
          ]),
        ],
        "calendar",
      ).state,
    ).toBe("not_connected");
  });
});
