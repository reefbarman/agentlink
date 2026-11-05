// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

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
  it("keeps pending metadata visible outside a collapsed Shelf and opens watches only on click", async () => {
    const vscodeApi = {
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    };
    render(<App vscodeApi={vscodeApi} />);
    const watch = {
      server: "comms",
      uri: "comms://inbox/one",
      mode: "notify",
      paused: false,
      pending: false,
    };
    deliver({ type: "mcpResourceWatches", watches: [watch] });
    fireEvent.click(
      screen.getByRole("button", { name: "Hide resource watches" }),
    );
    const handle = screen.getByRole("separator", {
      name: "Resize Chat Activity Shelf",
    });
    const shelf = handle.parentElement as HTMLElement;
    vi.spyOn(shelf, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 588, 400, 12),
    );
    vi.spyOn(
      document.querySelector(".chat-messages")!,
      "getBoundingClientRect",
    ).mockReturnValue(new DOMRect(0, 100, 400, 488));
    fireEvent.keyDown(handle, { key: "Home" });
    deliver({
      type: "mcpResourceWatches",
      watches: [{ ...watch, pending: true }],
    });
    const indicator = screen.getByRole("button", {
      name: "1 MCP update available",
    });
    expect(shelf.contains(indicator)).toBe(false);
    expect(shelf.style.height).toBe("12px");
    expect(
      screen.queryByRole("region", { name: "MCP resource watches" }),
    ).toBeNull();
    fireEvent.click(indicator);
    expect(
      screen.getByRole("region", { name: "MCP resource watches" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(Number.parseFloat(shelf.style.height)).toBeGreaterThanOrEqual(220),
    );
    // Environment must not mask an explicit reveal of already-open watches.
    deliver({
      type: "agentSlashCommandsUpdate",
      commands: [{ name: "environment", source: "builtin", builtin: true }],
    });
    const composer = screen.getByPlaceholderText(/Message\.\.\./);
    fireEvent.input(composer, { target: { value: "/environment" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(screen.getByText("Environment")).toBeTruthy();
    const panel = screen.getByRole("region", { name: "MCP resource watches" });
    const scroll = vi.fn();
    panel.scrollIntoView = scroll;
    fireEvent.keyDown(handle, { key: "Home" });
    expect(shelf.style.height).toBe("12px");
    fireEvent.click(indicator);
    await waitFor(() =>
      expect(Number.parseFloat(shelf.style.height)).toBeGreaterThanOrEqual(320),
    );
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    deliver({ type: "mcpResourceWatches", watches: [watch] });
    expect(
      screen.queryByRole("button", { name: /MCP update.*available/ }),
    ).toBeNull();
    expect(
      document.querySelector(".chat-activity-shelf-notification"),
    ).toBeNull();
    expect(
      vscodeApi.postMessage.mock.calls.some(
        ([message]) =>
          message.command === "agentSend" ||
          message.type === "mcpResourceWatchAction",
      ),
    ).toBe(false);
  });

  it("keeps the approval card visible and focused until the decision clears", () => {
    const vscodeApi = {
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    };
    render(<App vscodeApi={vscodeApi} />);
    deliver({
      type: "showApproval",
      request: {
        id: "watch-consent",
        kind: "mcp",
        toolOrigin: "mcp-resource",
        command: "Watch comms inbox",
        mcpChoices: [
          { label: "Deliver and wake", value: "wake" },
          { label: "Deny", value: "deny" },
        ],
      },
    });
    const approve = screen.getByRole("button", { name: "Deliver and wake" });
    approve.focus();
    deliver({
      type: "mcpResourceWatches",
      watches: [
        {
          server: "comms",
          uri: "comms://inbox/one",
          mode: "wake",
          paused: false,
          pending: false,
        },
      ],
    });
    expect(
      screen.queryByRole("region", { name: "MCP resource watches" }),
    ).toBeNull();
    expect(document.activeElement).toBe(approve);
    deliver({
      type: "mcpResourceWatches",
      watches: [
        {
          server: "comms",
          uri: "comms://inbox/one",
          mode: "notify",
          paused: false,
          pending: true,
        },
      ],
    });
    const indicator = screen.getByRole("button", {
      name: "1 MCP update available",
    }) as HTMLButtonElement;
    expect(indicator.disabled).toBe(true);
    expect(document.activeElement).toBe(approve);
    fireEvent.click(indicator);
    expect(
      screen.queryByRole("region", { name: "MCP resource watches" }),
    ).toBeNull();
    expect(document.activeElement).toBe(approve);
    deliver({ type: "idle", id: "watch-consent" });
    expect(
      screen.getByRole("region", { name: "MCP resource watches" }),
    ).toBeTruthy();
  });

  it("reveals a newly added watch after dismissal and expands a collapsed Shelf", async () => {
    const vscodeApi = {
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    };
    render(<App vscodeApi={vscodeApi} />);
    deliver({
      type: "agentSlashCommandsUpdate",
      commands: [{ name: "mcp-watches", source: "builtin", builtin: true }],
    });
    const composer = screen.getByPlaceholderText(/Message\.\.\./);
    fireEvent.input(composer, { target: { value: "/mcp-watches" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    fireEvent.click(
      screen.getByRole("button", { name: "Hide resource watches" }),
    );
    const handle = screen.getByRole("separator", {
      name: "Resize Chat Activity Shelf",
    });
    vi.spyOn(handle.parentElement!, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 588, 400, 12),
    );
    vi.spyOn(
      document.querySelector(".chat-messages")!,
      "getBoundingClientRect",
    ).mockReturnValue(new DOMRect(0, 100, 400, 488));
    fireEvent.keyDown(handle, { key: "Home" });
    expect((handle.parentElement as HTMLElement).style.height).toBe("12px");
    const watch = {
      server: "comms",
      uri: "comms://inbox/one",
      mode: "wake",
      paused: false,
      pending: false,
    };
    deliver({ type: "mcpResourceWatches", watches: [watch] });
    expect(
      screen.getByRole("region", { name: "MCP resource watches" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        Number.parseFloat((handle.parentElement as HTMLElement).style.height),
      ).toBeGreaterThanOrEqual(220),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Hide resource watches" }),
    );
    deliver({
      type: "mcpResourceWatches",
      watches: [{ ...watch, pending: true }],
    });
    expect(
      screen.queryByRole("region", { name: "MCP resource watches" }),
    ).toBeNull();
    deliver({
      type: "mcpResourceWatches",
      watches: [watch, { ...watch, uri: "comms://inbox/two" }],
    });
    expect(
      screen.getByRole("region", { name: "MCP resource watches" }),
    ).toBeTruthy();
    expect(
      vscodeApi.postMessage.mock.calls.some(
        ([message]) =>
          message.command === "agentSend" ||
          message.type === "mcpResourceWatchAction",
      ),
    ).toBe(false);
  });

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
