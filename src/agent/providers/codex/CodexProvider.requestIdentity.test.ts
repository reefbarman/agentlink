import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserGatewayAskAgentModelClient } from "../../../browser-gateway/helper/askAgentModelClient.js";
import { CodexProvider } from "./CodexProvider.js";
import { CodexTurnState } from "@agentlink/core/codex";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../../util/httpDispatcher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../util/httpDispatcher.js")>()),
  agentLinkFetch: fetchMock,
}));

const terminalEvent = {
  type: "response.completed",
  response: {
    id: "PRIVATE_RESPONSE",
    status: "completed",
    output: [],
    usage: { input_tokens: 1, output_tokens: 1 },
  },
};
const auth = {
  method: "oauth" as const,
  bearerToken: "PRIVATE_TOKEN",
  accountId: "PRIVATE_ACCOUNT",
  canRefresh: false,
};

describe("Codex request identity production wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each(["extension", "helper"] as const)(
    "reports final HTTP and WS identities in the %s path without private data",
    async (surface) => {
      vi.stubEnv("AGENTLINK_CODEX_ORIGINATOR", "distinct-originator");
      vi.stubEnv("AGENTLINK_CODEX_USER_AGENT", "distinct-client/9.8.7");
      fetchMock.mockImplementation(
        async () =>
          new Response(`data: ${JSON.stringify(terminalEvent)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      const logs: string[] = [];
      const turnState = new CodexTurnState();
      const connection = {
        headers: new Headers({ "x-codex-turn-state": "PRIVATE_ROUTING" }),
        isOpen: true,
        close: vi.fn(),
        dispatch: async function* () {
          yield terminalEvent;
        },
      };
      const connector = { connect: vi.fn().mockResolvedValue(connection) };
      const params = {
        model: "gpt-6.1-sol",
        systemPrompt: "PRIVATE_PROMPT",
        messages: [{ role: "user" as const, content: "PRIVATE_BODY" }],
        maxTokens: 64,
      };
      try {
        if (surface === "extension") {
          const authManager = {
            resolveModelAuth: vi.fn().mockResolvedValue(auth),
            getPreferredAuthMethod: vi.fn().mockResolvedValue("oauth"),
          };
          const http = new CodexProvider(authManager as never, (line) =>
            logs.push(line),
          );
          await http.complete(params);
          const ws = new CodexProvider(
            authManager as never,
            (line) => logs.push(line),
            { webSocketConnector: connector },
          );
          await ws.complete(params);
        } else {
          const credential = {
            ...auth,
            providerId: "openai-codex",
            accountLabel: "PRIVATE_EMAIL",
            grantedByOwnerId: "PRIVATE_OWNER",
            grantedByOwnerGenerationId: "PRIVATE_GENERATION",
            modelScopes: ["chat" as const],
            grantedAt: Date.now(),
            expiresAt: Date.now() + 60000,
          };
          const client = new BrowserGatewayAskAgentModelClient({
            sessionId: "PRIVATE_SESSION",
            responsesWebSocketConnector: connector,
            onCodexRequestIdentity: (diagnostics) =>
              logs.push(
                `[codex] request-identity source=browser-gateway-helper ${JSON.stringify(diagnostics)}`,
              ),
          });
          const helperParams = {
            credential,
            model: params.model,
            messages: [
              {
                id: "PRIVATE_MESSAGE",
                role: "user" as const,
                content: "PRIVATE_BODY",
                timestamp: 1,
                blocks: [{ type: "text" as const, text: "PRIVATE_BODY" }],
              },
            ],
          };
          await client.completeWithToolCalls(helperParams);
          await client.completeWithToolCalls({
            ...helperParams,
            codexRouting: {
              sessionId: "PRIVATE_SESSION",
              turnState,
              conversationState: undefined,
            },
          });
        }
        const identities = logs.filter((line) =>
          line.includes("request-identity "),
        );
        expect(identities).toHaveLength(2);
        const snapshots = identities.map((line) =>
          JSON.parse(line.slice(line.indexOf("{"))),
        );
        expect(snapshots).toEqual([
          {
            transport: "http",
            originator: "distinct-originator",
            userAgent: "distinct-client/9.8.7",
            version: null,
            openAIBeta: null,
            responsesLite: "true",
          },
          {
            transport: "websocket",
            originator: "distinct-originator",
            userAgent: "distinct-client/9.8.7",
            version: null,
            openAIBeta: "responses_websockets=2026-02-06",
            responsesLite: "true",
          },
        ]);
        expect(identities.join("\n")).not.toContain("PRIVATE_");
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(connector.connect).toHaveBeenCalledOnce();
        const httpHeaders = new Headers(fetchMock.mock.calls[0][1].headers);
        expect(httpHeaders.get("authorization")).toBe("Bearer PRIVATE_TOKEN");
        expect(connector.connect.mock.calls[0][0].headers.Authorization).toBe(
          "Bearer PRIVATE_TOKEN",
        );
      } finally {
        turnState.dispose();
      }
    },
  );
});
