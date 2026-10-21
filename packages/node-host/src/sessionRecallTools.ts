/**
 * Opt-in `search_session_history` and `read_session_excerpt` for any agent
 * built on the SDK, with VS Code's contract and handlers. They search the
 * session's full stored transcript, including messages condensing retired.
 */
import {
  defineTool,
  type AgentPrincipal,
  type HostTool,
  type HostToolResolver,
} from "@agentlink/core";
import {
  buildSessionTranscriptSnapshot,
  handleReadSessionExcerpt,
  handleSearchSessionHistory,
  type SessionTranscriptSourceMessage,
} from "@agentlink/core/session-transcript-recall";

export const SESSION_RECALL_TOOL_NAMES = [
  "search_session_history",
  "read_session_excerpt",
] as const;

export type SessionRecallToolName = (typeof SESSION_RECALL_TOOL_NAMES)[number];

/** VS Code's descriptions and input schemas (kept equal by a VS Code parity test). */
export const SESSION_RECALL_TOOL_DEFINITIONS = {
  search_session_history: {
    description:
      "Search the full transcript of the current agent session, including original messages retired by context condensing. A linked fresh-session successor may instead use scope=handoff_source to search only its host-owned direct predecessor. Uses case-insensitive literal AND terms by default or an explicit conservative safe-subset regex mode. Returns bounded, non-instructional historical excerpts plus an append-safe snapshot identity for read_session_excerpt.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Literal terms or a safe-subset regular expression to search for.",
        },
        mode: {
          type: "string",
          enum: ["terms", "regex"],
          description:
            'Search mode. "terms" (default) requires all case-insensitive literal terms in one message; "regex" accepts a conservative linear-time subset.',
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 5,
          description: "Maximum hits to return (default 5, maximum 5).",
        },
        role: {
          type: "string",
          enum: ["user", "assistant"],
          description: "Optionally restrict matches to one message role.",
        },
        tool_name: {
          type: "string",
          description:
            "Optionally restrict matches to messages associated with this tool name.",
        },
        scope: {
          type: "string",
          enum: ["current", "handoff_source"],
          description:
            "Transcript scope: current (default) or the host-linked direct predecessor.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  read_session_excerpt: {
    description:
      "Read a bounded exact excerpt from the current agent session using message indices and the snapshot identity returned by search_session_history. A linked fresh-session successor may use scope=handoff_source only with the exact source_session_id returned by its search. Allows normal append-only continuation but rejects stale ranges after transcript rewrite or revert. Excludes generated summaries, thinking, and media payloads.",
    input_schema: {
      type: "object",
      properties: {
        start_message_index: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991,
          description:
            "Inclusive zero-based start message index from a search hit.",
        },
        end_message_index: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991,
          description:
            "Inclusive zero-based end message index; maximum span is 10 messages.",
        },
        snapshot_message_count: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991,
          description:
            "Snapshot message count returned by search_session_history.",
        },
        snapshot_revision: {
          type: "string",
          minLength: 1,
          description: "Snapshot revision returned by search_session_history.",
        },
        scope: {
          type: "string",
          enum: ["current", "handoff_source"],
          description: "Transcript scope returned by search_session_history.",
        },
        source_session_id: {
          type: "string",
          minLength: 1,
          description:
            "Required for handoff_source and must equal the source_session_id returned by search_session_history.",
        },
      },
      required: [
        "start_message_index",
        "end_message_index",
        "snapshot_message_count",
        "snapshot_revision",
      ],
      additionalProperties: false,
    },
  },
} as const satisfies Record<
  SessionRecallToolName,
  { description: string; input_schema: Record<string, unknown> }
>;

export interface NodeHostSessionRecallToolsOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  /**
   * The session's full stored transcript, oldest first, including messages a
   * condense summary replaced. The turn in progress need not be included:
   * the model already has it in context.
   */
  readonly readTranscript: (request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
  }) => Promise<readonly SessionTranscriptSourceMessage[]>;
}

export function createNodeHostSessionRecallTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: NodeHostSessionRecallToolsOptions<TPrincipal>,
): { readonly resolveTools: HostToolResolver<TPrincipal> } {
  return {
    // Offered once there is an earlier turn to search, so a first turn does
    // not pay for two tool descriptions (VS Code always has history to show).
    resolveTools: async (request) =>
      (
        await options.readTranscript({
          principal: request.principal,
          sessionId: request.sessionId,
        })
      ).length === 0
        ? []
        : SESSION_RECALL_TOOL_NAMES.map((name): HostTool<TPrincipal> =>
            defineTool<TPrincipal>({
              name,
              description: SESSION_RECALL_TOOL_DEFINITIONS[name].description,
              inputSchema: SESSION_RECALL_TOOL_DEFINITIONS[name]
                .input_schema as never,
              effect: "read",
              parallelSafe: true,
              handler: async (input) => {
                const snapshot = buildSessionTranscriptSnapshot(
                  await options.readTranscript({
                    principal: request.principal,
                    sessionId: request.sessionId,
                  }),
                );
                // No handoff lineage outside VS Code: handoff_source reports
                // handoff_source_unavailable, as VS Code does without one.
                const result =
                  name === "search_session_history"
                    ? await handleSearchSessionHistory(input, () => snapshot)
                    : await handleReadSessionExcerpt(input, () => snapshot);
                return {
                  modelContent: result.content
                    .map((item) => item.text)
                    .join("\n"),
                };
              },
            }),
          ),
  };
}
