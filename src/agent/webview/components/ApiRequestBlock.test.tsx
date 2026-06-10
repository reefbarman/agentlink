// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { ApiRequestBlock } from "./ApiRequestBlock.js";

afterEach(() => cleanup());

describe("ApiRequestBlock", () => {
  it("renders context breakdown details when expanded", () => {
    render(
      <ApiRequestBlock
        requestId="req-1"
        model="test-model"
        inputTokens={1_000}
        uncachedInputTokens={100}
        cacheReadTokens={800}
        cacheCreationTokens={100}
        outputTokens={200}
        durationMs={1_500}
        timeToFirstToken={250}
        contextBreakdown={{
          prompt: {
            totalChars: 4_000,
            estimatedTokens: 1_000,
            sections: [
              { label: "base", chars: 2_000, estimatedTokens: 500 },
              {
                label: "skills toc",
                chars: 400,
                estimatedTokens: 100,
                count: 2,
              },
            ],
          },
          tools: {
            totalToolCount: 5,
            totalChars: 2_000,
            estimatedTokens: 500,
            native: {
              label: "native+meta tools",
              chars: 1_200,
              estimatedTokens: 300,
              count: 3,
            },
            mcp: {
              totalServerCount: 1,
              totalToolCount: 2,
              totalChars: 800,
              estimatedTokens: 200,
              servers: [
                {
                  serverName: "linear",
                  chars: 800,
                  estimatedTokens: 200,
                  toolCount: 2,
                },
              ],
            },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText("Prompt estimate")).toBeTruthy();
    expect(screen.getByText("1,000 tokens · 4,000 chars")).toBeTruthy();
    expect(screen.getByText(/base: 500 tokens/)).toBeTruthy();
    expect(screen.getByText(/skills toc: 100 tokens · 2 items/)).toBeTruthy();
    expect(screen.getByText("Tool schemas")).toBeTruthy();
    expect(screen.getByText("500 tokens · 5 tools")).toBeTruthy();
    expect(screen.getByText(/linear: 200 tokens · 2 tools/)).toBeTruthy();
  });
});
