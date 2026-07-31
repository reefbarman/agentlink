// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { App } from "./App.js";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => cleanup());

function createVsCodeApi() {
  return {
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
  };
}

function deliver(message: unknown): void {
  fireEvent(window, new MessageEvent("message", { data: message }));
}

describe("App environment panel integration", () => {
  it("opens projected environment details in the Activity Shelf", () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);

    deliver({
      type: "agentDebugInfo",
      info: { platform: "darwin" },
      systemPrompt: "workspace system prompt",
      loadedInstructions: [
        { source: "AGENTS.md", chars: 120, promptChars: 100 },
      ],
    });
    deliver({
      type: "agentSlashCommandsUpdate",
      commands: [
        {
          name: "environment",
          description: "Open environment details",
          source: "builtin",
          builtin: true,
        },
      ],
    });

    expect(screen.queryByText("Environment")).toBeNull();
    const composer = screen.getByPlaceholderText(/Message\.\.\./);
    fireEvent.input(composer, { target: { value: "/environment" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(screen.getByText("Environment")).toBeTruthy();
    expect(vscodeApi.postMessage).toHaveBeenCalledWith({
      command: "agentRefreshDebugInfo",
      sessionId: null,
    });
    expect(screen.getByText("platform")).toBeTruthy();
    expect(
      screen.getByText("Loaded Instructions (1 file, 100 body prompt chars)"),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("System Prompt"));
    expect(screen.getByText("workspace system prompt")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close Environment" }));
    expect(screen.queryByText("Environment")).toBeNull();
  });
});
