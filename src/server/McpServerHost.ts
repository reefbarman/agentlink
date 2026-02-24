import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import type * as http from "http";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { registerTools } from "./registerTools.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

const SESSION_IDLE_TTL = 30 * 60_000; // 30 minutes
const CLEANUP_INTERVAL = 5 * 60_000; // 5 minutes

export class McpServerHost {
  private sessions = new Map<string, Session>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private authToken: string | undefined;
  private approvalManager: ApprovalManager;
  private approvalPanel: ApprovalPanelProvider;

  constructor(authToken: string | undefined, approvalManager: ApprovalManager, approvalPanel: ApprovalPanelProvider) {
    this.authToken = authToken;
    this.approvalManager = approvalManager;
    this.approvalPanel = approvalPanel;
    this.cleanupInterval = setInterval(() => this.pruneIdleSessions(), CLEANUP_INTERVAL);
  }

  async handleRequest(req: http.IncomingMessage, res: http.ServerResponse, parsedBody?: unknown): Promise<void> {
    // Auth check
    if (this.authToken && !this.validateAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Existing session → route to its transport
    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res, parsedBody);
      return;
    }

    // Unknown session ID → create a new session reusing the old ID.
    // This allows clients to recover transparently after server restart/reload
    // instead of getting stuck on 404 errors.

    // No session ID → new client connecting
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId ?? randomUUID(),
    });

    const server = new McpServer({
      name: "native-claude",
      version: "0.1.0",
    });

    registerTools(server, this.approvalManager, this.approvalPanel, () => transport.sessionId);
    await server.connect(transport);

    // Handle the initialization request
    await transport.handleRequest(req, res, parsedBody);

    // Store session for future requests
    if (transport.sessionId) {
      this.sessions.set(transport.sessionId, {
        transport,
        server,
        lastActivity: Date.now(),
      });
    }

    transport.onclose = () => {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId);
      }
    };
  }

  private validateAuth(req: http.IncomingMessage): boolean {
    if (!this.authToken) {
      return true;
    }
    const header = req.headers.authorization;
    if (!header) {
      return false;
    }
    const [scheme, token] = header.split(" ", 2);
    return scheme === "Bearer" && token === this.authToken;
  }

  private pruneIdleSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > SESSION_IDLE_TTL) {
        session.transport.close().catch(() => {});
        session.server.close().catch(() => {});
        this.sessions.delete(id);
      }
    }
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupInterval);
    for (const [, session] of this.sessions) {
      await session.transport.close().catch(() => {});
      await session.server.close().catch(() => {});
    }
    this.sessions.clear();
  }
}
