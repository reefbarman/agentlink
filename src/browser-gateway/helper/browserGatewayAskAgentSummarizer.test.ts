/** @vitest-environment node */

import {
  BrowserGatewayAskAgentModelSummarizer,
  findAskAgentSummarySecretLikeContent,
  parseAskAgentSummaryJson,
  redactAskAgentSummaryInputText,
} from "./browserGatewayAskAgentSummarizer.js";
import { describe, expect, it } from "vitest";

import type { BrowserGatewayModelCredentialRecord } from "../browserGatewayModelCredentialCache.js";
import type OpenAI from "openai";

async function* streamText(text: string): AsyncIterable<unknown> {
  yield { type: "response.output_text.delta", delta: text };
}

function credential(): BrowserGatewayModelCredentialRecord {
  return {
    providerId: "openai-codex",
    method: "oauth",
    bearerToken: "token",
    grantedByOwnerId: "vscode-owner",
    modelScopes: ["chat"],
    grantedAt: Date.now(),
    canRefresh: true,
  };
}

describe("BrowserGatewayAskAgentSummarizer", () => {
  it("parses validated summary JSON from plain or fenced text", () => {
    const summary = parseAskAgentSummaryJson(`\n\`\`\`json
{
  "title": "Ask Agent memory",
  "summary": "User discussed Browser Ask Agent memory.",
  "topics": ["memory", "browser"],
  "decisions": ["Use local lexical memory first"],
  "openQuestions": [],
  "durableCandidateHints": ["Maybe remember browser randomId guidance"],
  "latestTurn": {
    "summary": "Implemented local memory store foundation.",
    "keywords": ["memory", "store"],
    "entities": ["Browser Ask Agent"]
  }
}
\`\`\``);

    expect(summary).toEqual({
      title: "Ask Agent memory",
      summary: "User discussed Browser Ask Agent memory.",
      topics: ["memory", "browser"],
      decisions: ["Use local lexical memory first"],
      openQuestions: [],
      durableCandidateHints: ["Maybe remember browser randomId guidance"],
      latestTurn: {
        summary: "Implemented local memory store foundation.",
        keywords: ["memory", "store"],
        entities: ["Browser Ask Agent"],
      },
    });
  });

  it("detects secret-like content in generated summaries", () => {
    const summary = parseAskAgentSummaryJson(
      JSON.stringify({
        title: "Deployment notes",
        summary:
          "User pasted api_key = sk-proj-abcdefghijklmnopqrstuvwxyz1234 while debugging.",
        topics: ["deployment"],
        decisions: [],
        openQuestions: [],
        durableCandidateHints: [],
        latestTurn: {
          summary: "Discussed configuration setup.",
          keywords: ["config"],
          entities: ["Ask Agent"],
        },
      }),
    );

    expect(findAskAgentSummarySecretLikeContent(summary)).toEqual({
      field: "summary",
      pattern: "openai_api_key",
    });
  });

  it("redacts secret-like values from summarizer input text", () => {
    const result = redactAskAgentSummaryInputText(
      "Debug model auth with token: ghp_abcdefghijklmnopqrstuvwxyz123456 and keep the deployment context.",
    );

    expect(result).toEqual({
      text: "Debug model auth with token: [REDACTED_SECRET] and keep the deployment context.",
      redacted: true,
    });
  });

  it("leaves ordinary summarizer input text unchanged", () => {
    expect(
      redactAskAgentSummaryInputText(
        "Discussed token budgeting and credential lease refresh behavior without sharing credentials.",
      ),
    ).toEqual({
      text: "Discussed token budgeting and credential lease refresh behavior without sharing credentials.",
      redacted: false,
    });
  });

  it("does not flag ordinary technical summary text as secret-like", () => {
    const summary = parseAskAgentSummaryJson(
      JSON.stringify({
        title: "Browser Ask Agent memory",
        summary:
          "User discussed token budgeting and credential lease refresh behavior without sharing credentials.",
        topics: ["memory", "model auth", "token budgets"],
        decisions: ["Keep memory injected as instructions."],
        openQuestions: [],
        durableCandidateHints: [],
        latestTurn: {
          summary:
            "Planned deterministic retrieval for local memory summaries.",
          keywords: ["memory", "retrieval"],
          entities: ["Browser Ask Agent"],
        },
      }),
    );

    expect(findAskAgentSummarySecretLikeContent(summary)).toBeNull();
  });

  it("rejects invalid or incomplete summary JSON", () => {
    expect(() => parseAskAgentSummaryJson("not json")).toThrow(
      /browser_gateway_ask_agent_memory_invalid_json/,
    );
    expect(() =>
      parseAskAgentSummaryJson(
        JSON.stringify({ summary: "missing latest turn", latestTurn: {} }),
      ),
    ).toThrow(/browser_gateway_ask_agent_memory_invalid_json/);
  });

  it("redacts transcript content before sending summarizer input to the model", async () => {
    const createCalls: unknown[] = [];
    const summarizer = new BrowserGatewayAskAgentModelSummarizer({
      sessionId: "ask-session",
      createClient: () =>
        ({
          responses: {
            create: async (body: unknown) => {
              createCalls.push(body);
              return streamText(
                JSON.stringify({
                  title: "Redacted summary",
                  summary: "Conversation summary from redacted context.",
                  topics: ["auth"],
                  decisions: [],
                  openQuestions: [],
                  durableCandidateHints: [],
                  latestTurn: {
                    summary: "Latest turn summary.",
                    keywords: ["auth"],
                    entities: ["Ask Agent"],
                  },
                }),
              );
            },
          },
        }) as Pick<OpenAI, "responses">,
    });

    await summarizer.summarize({
      credential: credential(),
      messages: [
        {
          id: "user-1",
          role: "user",
          content:
            "Please remember this deployment context. api_key = sk-proj-abcdefghijklmnopqrstuvwxyz1234",
          blocks: [],
          timestamp: Date.now(),
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "I will keep only the non-sensitive context.",
          blocks: [],
          timestamp: Date.now(),
        },
      ],
    });

    const serializedCall = JSON.stringify(createCalls[0]);
    expect(serializedCall).not.toContain(
      "sk-proj-abcdefghijklmnopqrstuvwxyz1234",
    );
    expect(serializedCall).toContain("[REDACTED_SECRET]");
    expect(serializedCall).toContain(
      "Please remember this deployment context.",
    );
  });

  it("calls the model with the summary prompt and parses streamed JSON", async () => {
    const createCalls: unknown[] = [];
    const summarizer = new BrowserGatewayAskAgentModelSummarizer({
      sessionId: "ask-session",
      createClient: () =>
        ({
          responses: {
            create: async (body: unknown) => {
              createCalls.push(body);
              return streamText(
                JSON.stringify({
                  title: "Model summary",
                  summary: "Conversation summary from model.",
                  topics: ["summaries"],
                  decisions: [],
                  openQuestions: [],
                  durableCandidateHints: [],
                  latestTurn: {
                    summary: "Latest turn summary.",
                    keywords: ["latest"],
                    entities: ["Ask Agent"],
                  },
                }),
              );
            },
          },
        }) as Pick<OpenAI, "responses">,
    });

    const result = await summarizer.summarize({
      credential: credential(),
      model: "gpt-5.3-codex",
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Summarize this later",
          blocks: [{ type: "text", text: "Summarize this later" }],
          timestamp: Date.now(),
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "I will remember the high-level context.",
          blocks: [
            { type: "text", text: "I will remember the high-level context." },
          ],
          timestamp: Date.now(),
        },
      ],
      existingSessionSummary: "Existing summary",
    });

    expect(result.summary).toBe("Conversation summary from model.");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      model: "gpt-5.5",
      stream: true,
      store: false,
      instructions: expect.stringContaining("Return only valid JSON"),
    });
    expect(createCalls[0]).toMatchObject({
      instructions: expect.stringContaining(
        "Ordinary user-provided names, preferred names, nicknames",
      ),
    });
    expect(createCalls[0]).toMatchObject({
      instructions: expect.stringContaining("shared a name"),
    });
    expect(
      (createCalls[0] as Record<string, unknown>).max_output_tokens,
    ).toBeUndefined();
    expect(JSON.stringify(createCalls[0])).toContain("Existing summary");
    expect(JSON.stringify(createCalls[0])).toContain("Summarize this later");
  });

  it("maps core Responses auth failures to Ask Agent memory auth errors", async () => {
    const summarizer = new BrowserGatewayAskAgentModelSummarizer({
      sessionId: "ask-session",
      createClient: () =>
        ({
          responses: {
            create: async () => {
              throw Object.assign(new Error("unauthorized"), { status: 401 });
            },
          },
        }) as unknown as Pick<OpenAI, "responses">,
    });

    await expect(
      summarizer.summarize({ credential: credential(), messages: [] }),
    ).rejects.toThrow("browser_gateway_ask_agent_memory_auth_failed");
  });

  it("maps core Responses aborts to Ask Agent memory abort errors", async () => {
    const controller = new AbortController();
    const summarizer = new BrowserGatewayAskAgentModelSummarizer({
      sessionId: "ask-session",
      createClient: () =>
        ({
          responses: {
            create: async () =>
              (async function* () {
                yield { type: "response.output_text.delta", delta: "{" };
                controller.abort();
                yield { type: "response.output_text.delta", delta: "ignored" };
              })(),
          },
        }) as unknown as Pick<OpenAI, "responses">,
    });

    await expect(
      summarizer.summarize({
        credential: credential(),
        messages: [],
        signal: controller.signal,
      }),
    ).rejects.toThrow("browser_gateway_ask_agent_memory_aborted");
  });
});
