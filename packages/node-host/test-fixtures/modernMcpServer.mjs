import * as z from "zod";

// Stdio MCP server used by the protocol negotiation tests. By default it is
// served with `serveStdio`, which answers both the 2026-07-28
// `server/discover` probe and the 2025-era `initialize` handshake.
// FIXTURE_ERA=legacy serves the 2025-era handshake only.
import {
  McpServer,
  acceptedContent,
  inputRequired,
} from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";

const confirmation = z.object({ confirm: z.boolean() });

function createServer() {
  const server = new McpServer(
    { name: "agentlink-modern-fixture", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.registerTool(
    "echo",
    {
      description: "Echo text back",
      inputSchema: z.object({ text: z.string() }),
    },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );

  server.registerTool(
    "confirm",
    { description: "Ask the user to confirm", inputSchema: z.object({}) },
    async (_args, ctx) => {
      const answer = acceptedContent(
        ctx.mcpReq.inputResponses,
        "confirm",
        confirmation,
      );
      if (answer === undefined) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: "Proceed?",
              requestedSchema: confirmation,
            }),
          },
        });
      }
      return {
        content: [
          { type: "text", text: answer.confirm ? "confirmed" : "refused" },
        ],
      };
    },
  );

  server.registerTool(
    "add_tool",
    { description: "Register another tool", inputSchema: z.object({}) },
    async () => {
      server.registerTool(
        "late_tool",
        { description: "Registered after connect", inputSchema: z.object({}) },
        async () => ({ content: [{ type: "text", text: "late" }] }),
      );
      server.sendToolListChanged();
      return { content: [{ type: "text", text: "added" }] };
    },
  );

  return server;
}

if (process.env.FIXTURE_ERA === "legacy") {
  await createServer().connect(new StdioServerTransport());
} else {
  serveStdio(createServer);
}
