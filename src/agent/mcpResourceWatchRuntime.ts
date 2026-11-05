import { createHash, randomUUID } from "node:crypto";

import type { McpClientHub } from "@agentlink/node-host";
import { McpResourceWatches } from "../core/mcpResourceWatches.js";
import type { McpSessionContext } from "../core/capabilities/mcp.js";
import type { OnApprovalRequest } from "@agentlink/protocol/inline-approval";

/** Surface-owned composition. The policy itself does not know about tabs or MCP SDK clients. */
export function createSessionMcpResourceWatches(options: {
  sessionId: string;
  getHub(): McpClientHub | undefined;
  getSessionContext(): McpSessionContext | undefined;
  requestApproval: OnApprovalRequest | undefined;
  isActive(): boolean;
  onChange(): void;
  onPending(): void;
}): McpResourceWatches {
  return new McpResourceWatches({
    getServerIdentity(server) {
      if (!options.isActive()) return undefined;
      const config = options.getHub()?.getServerConfig(server);
      if (!config || config.disabled) return undefined;
      // Keep credentials out of grants and UI, including config-derived identifiers.
      return createHash("sha256").update(JSON.stringify(config)).digest("hex");
    },
    async requestApproval({ server, uri, mode }) {
      if (!options.requestApproval || !options.isActive()) return "deny";
      const response = await options.requestApproval(
        {
          id: `mcp-resource:${options.sessionId}:${randomUUID()}`,
          kind: "mcp",
          toolOrigin: "mcp-resource",
          mcpServerName: server,
          mcpToolName: uri,
          title: `Watch MCP resource from ${server} in this session?`,
          detail: `Resource: ${uri}\nRequested delivery: ${mode}\n\nFuture contents are unknown, untrusted MCP data, not instructions from you. Automatic delivery permits repeated reads of this exact resource. Deliver and wake can start idle turns and spend model tokens. This does not approve actions requested by the content. Permission ends when this loaded session closes or AgentLink reloads.`,
          humanOnlyReason:
            "Standing resource delivery and idle waking require your explicit session consent.",
          choices: [
            { label: "Notify only", value: "notify" },
            { label: "Deliver automatically", value: "deliver" },
            { label: "Deliver and wake", value: "wake" },
            { label: "Deny", value: "deny", isDanger: true },
          ],
        },
        options.sessionId,
      );
      if (!options.isActive()) return "deny";
      const decision =
        typeof response === "string" ? response : response.decision;
      return decision === "notify" ||
        decision === "deliver" ||
        decision === "wake"
        ? decision
        : "deny";
    },
    async subscribe(server, uris, handlers) {
      const hub = options.getHub();
      if (!hub || !options.isActive())
        throw new Error("MCP resource watch host unavailable.");
      return hub.subscribeResources(server, options.sessionId, uris, {
        sessionContext: options.getSessionContext(),
        onUpdated: handlers.onUpdated,
        onError: handlers.onError,
        onReconnected: handlers.onReconnected,
      });
    },
    async read(server, uri, signal) {
      const hub = options.getHub();
      if (!hub || !options.isActive())
        return { error: "MCP resource watch host unavailable." };
      const result = await hub.readResource(server, uri, {
        sessionContext: options.getSessionContext(),
        signal,
        interactive: false,
      });
      if (result.isError)
        return {
          error:
            "Resource read failed or needs user interaction. Resume after checking the MCP connection.",
        };
      if (result.content.some((part) => part.type !== "text"))
        return { error: "Automatic resource updates support text only." };
      return {
        text: result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      };
    },
    onChange: options.onChange,
    onPending: options.onPending,
  });
}
