// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { ModelSelector } from "./ModelSelector";
import type { ChatModelInfo as WebviewModelInfo } from "@agentlink/protocol/chat-catalog";

const models: WebviewModelInfo[] = [
  {
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    provider: "codex",
    contextWindow: 200_000,
    authenticated: true,
    condenseThreshold: 0.9,
  },
  {
    id: "openrouter-moonshotai-kimi-k3",
    displayName: "Kimi K3",
    provider: "openai-compatible:openrouter-moonshotai-kimi-k3",
    providerDisplayName: "OpenRouter — Kimi K3",
    contextWindow: 1_048_576,
    authenticated: true,
    condenseThreshold: 0.9,
  },
];

afterEach(() => {
  cleanup();
});

describe("ModelSelector", () => {
  it("shows a neutral label before the selected model is hydrated", () => {
    render(
      <ModelSelector currentModel="" models={models} onSelect={vi.fn()} />,
    );

    expect(screen.getByText("Loading model…")).toBeTruthy();
    expect(screen.queryByText("Claude Sonnet 4.6")).toBeNull();
  });

  it("selects an authenticated model from the portaled dropdown", () => {
    const onSelect = vi.fn();
    render(
      <ModelSelector
        currentModel="gpt-5.6-sol"
        currentCondenseThreshold={0.9}
        models={models}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByTitle(/Model: GPT-5\.6 Sol/));
    fireEvent.click(screen.getByRole("button", { name: /Kimi K3/ }));

    expect(onSelect).toHaveBeenCalledWith("openrouter-moonshotai-kimi-k3");
  });

  it("keeps active-model threshold interaction separate from selection", () => {
    const onSelect = vi.fn();
    render(
      <ModelSelector
        currentModel="gpt-5.6-sol"
        currentCondenseThreshold={0.9}
        models={models}
        onSelect={onSelect}
        onSetCondenseThreshold={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle(/Model: GPT-5\.6 Sol/));
    fireEvent.click(screen.getByTitle(/Auto-condense 90% — click to adjust/));

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("slider")).toBeTruthy();
  });

  it("routes an unauthenticated model to sign-in", () => {
    const onSelect = vi.fn();
    const onSignIn = vi.fn();
    render(
      <ModelSelector
        currentModel="gpt-5.6-sol"
        currentCondenseThreshold={0.9}
        models={[models[0]!, { ...models[1]!, authenticated: false }]}
        onSelect={onSelect}
        onSignIn={onSignIn}
      />,
    );

    fireEvent.click(screen.getByTitle(/Model: GPT-5\.6 Sol/));
    fireEvent.click(screen.getByRole("button", { name: /Kimi K3/ }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(onSignIn).toHaveBeenCalledWith(
      "openai-compatible:openrouter-moonshotai-kimi-k3",
    );
  });

  it("groups multiple OpenRouter models together under a single OpenRouter header", () => {
    const multiModels: WebviewModelInfo[] = [
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        provider: "codex",
        providerDisplayName: "ChatGPT/Codex",
        contextWindow: 200_000,
        authenticated: true,
      },
      {
        id: "openrouter-moonshotai-kimi-k3",
        displayName: "MoonshotAI: Kimi K3",
        provider: "openai-compatible:openrouter-moonshotai-kimi-k3",
        providerDisplayName: "OpenRouter — MoonshotAI: Kimi K3",
        contextWindow: 1_048_576,
        authenticated: true,
      },
      {
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        provider: "anthropic",
        providerDisplayName: "Claude",
        contextWindow: 200_000,
        authenticated: true,
      },
      {
        id: "openrouter-google-gemini-3-7-flash",
        displayName: "Google: Gemini 3.7 Flash",
        provider: "openai-compatible:openrouter-google-gemini-3-7-flash",
        providerDisplayName: "OpenRouter — Google: Gemini 3.7 Flash",
        contextWindow: 1_048_576,
        authenticated: true,
      },
    ];

    render(
      <ModelSelector
        currentModel="gpt-5.6-sol"
        models={multiModels}
        onSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle(/Model: GPT-5\.6 Sol/));

    const openRouterHeaders = screen.getAllByText("OpenRouter");
    expect(openRouterHeaders).toHaveLength(1);

    expect(
      screen.getByRole("button", { name: /MoonshotAI: Kimi K3/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Google: Gemini 3\.7 Flash/ }),
    ).toBeTruthy();
  });
});
