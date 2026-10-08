/**
 * Meridian runs this after its built-in OpenAI adapter transform.
 * AgentLink owns discovery, tool execution, approvals, and file-change UI.
 * Use its advertised catalog directly instead of duplicating tool names here.
 */
export function isAgentLinkRequest(ctx) {
  return (
    ctx.adapter === "openai" &&
    Boolean(ctx.headers.get("x-session-affinity")?.trim()) &&
    typeof ctx.systemContext === "string" &&
    /^\s*You are AgentLink,/.test(ctx.systemContext)
  );
}

export default {
  name: "agentlink-client-tools",
  version: "0.1.0",
  description:
    "Keep AgentLink's advertised tools eager for single-turn client handoff",
  adapters: ["openai"],
  onRequest(ctx) {
    if (!isAgentLinkRequest(ctx)) return ctx;
    return {
      ...ctx,
      // Undefined disables Meridian's automatic deferral; it does not remove
      // tools or override explicit defer_loading flags on individual tools.
      coreToolNames: undefined,
      passthrough: true,
      shouldTrackFileChanges: false,
    };
  },
};
