import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_MODES } from "./modes.js";
import {
  createAgentToolRuntime,
  dispatchToolCall,
  getAgentTools,
  type ToolDispatchContext,
} from "./toolAdapter.js";

function makeContext(
  provider?: ToolDispatchContext["mcpResourceWatchProvider"],
): ToolDispatchContext {
  return {
    approvalManager: {} as ToolDispatchContext["approvalManager"],
    approvalPanel: {} as ToolDispatchContext["approvalPanel"],
    extensionUri: {} as ToolDispatchContext["extensionUri"],
    sessionId: "watch-session",
    mcpResourceWatchProvider: provider,
  };
}

const watchTools = ["watch_mcp_resource", "unwatch_mcp_resource"];

describe("MCP resource-watch tool host capability", () => {
  it("does not advertise watches by default, even in a mode that permits MCP", () => {
    const mode = BUILT_IN_MODES.find((entry) => entry.slug === "code")!;
    expect(getAgentTools(mode).map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(watchTools),
    );
    for (const name of watchTools) {
      expect(getAgentTools().map((tool) => tool.name)).not.toContain(name);
      expect(
        createAgentToolRuntime(makeContext())
          .listTools({ mode })
          .map((tool) => tool.name),
      ).not.toContain(name);
    }
    const enabled = getAgentTools(
      mode,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      false,
      false,
      true,
    );
    expect(enabled.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(watchTools),
    );
  });

  it("forwards the provider capability through the production runtime tool catalogue", () => {
    const provider = { watch: vi.fn(), unwatch: vi.fn() };
    const mode = BUILT_IN_MODES.find((entry) => entry.slug === "code")!;
    const tools = createAgentToolRuntime(makeContext(provider)).listTools({
      mode,
    });
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(watchTools),
    );
    const restricted = createAgentToolRuntime(makeContext(provider)).listTools({
      mode,
      skillAllowedTools: ["read_file"],
    });
    for (const name of watchTools)
      expect(restricted.map((tool) => tool.name)).not.toContain(name);
  });

  it.each(watchTools)(
    "rejects %s dispatch on unsupported hosts",
    async (name) => {
      const result = await dispatchToolCall(
        name,
        { server: "notes", uri: "testbed://note/a", delivery: "wake" },
        makeContext(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            error: "MCP resource watches are unavailable on this host.",
          }),
        },
      ]);
    },
  );

  it("preserves the exact resource and delivery mode through dispatch without ordinary tool approval", async () => {
    const provider = {
      watch: vi.fn().mockResolvedValue({ ok: true }),
      unwatch: vi.fn().mockResolvedValue({ ok: true }),
    };
    const onApprovalRequest = vi.fn();
    const context = { ...makeContext(provider), onApprovalRequest };
    const server = "notes-distinct";
    const uri = "testbed://note/a?exact=1";
    await dispatchToolCall(
      "watch_mcp_resource",
      { server, uri, delivery: "wake" },
      context,
    );
    expect(provider.watch).toHaveBeenCalledExactlyOnceWith({
      server,
      uri,
      mode: "wake",
    });
    await dispatchToolCall("unwatch_mcp_resource", { server, uri }, context);
    expect(provider.unwatch).toHaveBeenCalledExactlyOnceWith({ server, uri });
    expect(onApprovalRequest).not.toHaveBeenCalled();
  });
});
