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
afterEach(cleanup);

function deliver(message: unknown): void {
  fireEvent(window, new MessageEvent("message", { data: message }));
}

describe("App resource-watch panel", () => {
  it("stays hidden through updates and reopens locally with /mcp-watches", () => {
    const vscodeApi = {
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    };
    render(<App vscodeApi={vscodeApi} />);
    const watches = [
      {
        server: "comms",
        uri: "comms://inbox/one",
        mode: "wake",
        paused: false,
        pending: false,
      },
    ];
    deliver({ type: "mcpResourceWatches", watches });
    deliver({
      type: "agentSlashCommandsUpdate",
      commands: [
        {
          name: "mcp-watches",
          description: "Show resource watches",
          source: "builtin",
          builtin: true,
        },
      ],
    });
    expect(
      screen.getByRole("region", { name: "MCP resource watches" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Hide resource watches" }),
    );
    deliver({
      type: "mcpResourceWatches",
      watches: [{ ...watches[0], pending: true }],
    });
    expect(
      screen.queryByRole("region", { name: "MCP resource watches" }),
    ).toBeNull();
    const composer = screen.getByPlaceholderText(/Message\.\.\./);
    fireEvent.input(composer, { target: { value: "/mcp-watches" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(
      screen.getByRole("region", { name: "MCP resource watches" }),
    ).toBeTruthy();
    expect(screen.getByText("Update pending")).toBeTruthy();
    expect(
      vscodeApi.postMessage.mock.calls.some(
        ([message]) =>
          message.command === "agentSend" ||
          message.type === "mcpResourceWatchAction",
      ),
    ).toBe(false);
  });
});
