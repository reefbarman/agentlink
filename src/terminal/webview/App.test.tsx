/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./xtermRenderer.js", () => ({
  xtermRendererFactory: { create: vi.fn() },
}));

import { App } from "./App.js";
import {
  TerminalWebviewController,
  type TerminalRenderer,
} from "./terminalWebviewController.js";

function controller() {
  const renderer: TerminalRenderer = {
    open: vi.fn(),
    write: vi.fn(async () => undefined),
    reset: vi.fn(),
    focus: vi.fn(),
    fit: vi.fn(() => ({ columns: 80, rows: 24 })),
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearSearch: vi.fn(),
    registerBlockBoundary: vi.fn(() => true),
    retainBlockAnchors: vi.fn(),
    updateConfiguration: vi.fn(),
    dispose: vi.fn(),
  };
  const postMessage = vi.fn();
  const terminalController = new TerminalWebviewController({
    vscodeApi: { postMessage },
    rendererFactory: { create: () => renderer },
    createRequestId: () => "request-id",
    createResizeObserver: () => ({ observe: vi.fn(), disconnect: vi.fn() }),
  });
  return { postMessage, renderer, terminalController };
}

afterEach(() => cleanup());

describe("terminal App", () => {
  it("renders the empty state while automatically creating the first terminal", async () => {
    const test = controller();
    render(
      <App
        vscodeApi={{ postMessage: test.postMessage }}
        controller={test.terminalController}
      />,
    );
    await test.terminalController.receive({
      type: "terminal-view/bootstrap",
      protocolVersion: 1,
      rendererEpoch: "renderer-1",
      state: { tabs: [] },
      configuration: { scrollback: 1000 },
      replay: [],
    });

    expect(
      screen.getByText("No terminals", { selector: "strong" }),
    ).toBeTruthy();
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "host-terminal/create",
      requestId: "terminal-create-1-request-id",
    });
    expect((screen.getByText("Creating…") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("renders fallback and forwards the explicit native-terminal action", async () => {
    const test = controller();
    render(
      <App
        vscodeApi={{ postMessage: test.postMessage }}
        controller={test.terminalController}
      />,
    );
    await test.terminalController.receive({
      type: "terminal-view/bootstrap",
      protocolVersion: 1,
      rendererEpoch: "renderer-1",
      state: { tabs: [] },
      configuration: { scrollback: 1000 },
      replay: [],
      fallback: {
        reason: "native-shell-required",
        message: "This profile requires the native terminal.",
      },
    });

    expect(
      screen.getByText("This profile requires the native terminal."),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Native Terminal" }),
    );
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "terminal-view/open-native-fallback",
      rendererEpoch: "renderer-1",
    });
  });

  it("labels sandbox tabs without changing their host-authoritative routing", async () => {
    const test = controller();
    render(
      <App
        vscodeApi={{ postMessage: test.postMessage }}
        controller={test.terminalController}
      />,
    );
    await test.terminalController.receive({
      type: "terminal-view/bootstrap",
      protocolVersion: 1,
      rendererEpoch: "renderer-1",
      state: {
        tabs: [
          {
            id: "sandbox-1",
            title: "Sandbox",
            channelKind: "agent-sandbox",
            cwd: "/workspace",
            profileName: "AgentLink Sandbox",
            dimensions: { columns: 80, rows: 24 },
            status: "running",
          },
        ],
        activeTabId: "sandbox-1",
      },
      configuration: { scrollback: 1000 },
      replay: [
        {
          terminalId: "sandbox-1",
          terminalInstanceId: "sandbox-instance-1",
          sequence: 0,
          data: "$ ",
          byteLength: 2,
          droppedBytes: 0,
          replayTruncated: false,
          replayPendingControl: false,
          blocks: {
            blocks: [],
            currentCwd: "/workspace",
            mode: "raw",
            droppedBlocks: 0,
            nextBlockNumber: 1,
            maxBlockOutputBytes: 1024,
            maxBlocks: 20,
          },
          presentation: {
            alternateScreen: false,
            terminalRunning: true,
            blocks: [],
          },
        },
      ],
    });

    const sandboxIcons = screen.getAllByTitle("Fresh sandbox per command");
    expect(sandboxIcons).toHaveLength(2);
    expect(
      sandboxIcons.every((icon) =>
        icon.classList.contains("terminal-sandbox-icon"),
      ),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Focus Sandbox (Sandbox)" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("combobox", { name: "Active terminal" }),
    ).toBeNull();
  });

  it("hides parser-only blocks and renders only host-advertised command actions", async () => {
    const test = controller();
    render(
      <App
        vscodeApi={{ postMessage: test.postMessage }}
        controller={test.terminalController}
      />,
    );
    await test.terminalController.receive({
      type: "terminal-view/bootstrap",
      protocolVersion: 1,
      rendererEpoch: "renderer-1",
      state: {
        tabs: [
          {
            id: "terminal-1",
            title: "zsh",
            cwd: "/workspace",
            profileName: "zsh",
            dimensions: { columns: 80, rows: 24 },
            status: "running",
          },
        ],
        activeTabId: "terminal-1",
      },
      configuration: { scrollback: 1000 },
      replay: [
        {
          terminalId: "terminal-1",
          terminalInstanceId: "instance-1",
          sequence: 0,
          data: "retained raw output",
          byteLength: 19,
          droppedBytes: 0,
          replayTruncated: false,
          replayPendingControl: false,
          blocks: {
            blocks: [
              {
                id: "host-block-1",
                kind: "raw",
                cwd: "/workspace",
                output: "retained raw output",
                outputBytes: 19,
                droppedOutputBytes: 0,
              },
            ],
            currentCwd: "/workspace",
            mode: "raw",
            droppedBlocks: 0,
            nextBlockNumber: 2,
            maxBlockOutputBytes: 1000,
            maxBlocks: 20,
          },
          presentation: {
            alternateScreen: false,
            terminalRunning: true,
            blocks: [
              {
                blockId: "host-block-1",
                decoration: "undecorated",
                actions: ["copy-output"],
              },
            ],
          },
        },
      ],
    });

    expect(
      screen.queryByText("Raw shell — command tracking unavailable"),
    ).toBeNull();
    expect(screen.queryByText("Raw output")).toBeNull();
    expect(screen.queryByLabelText("Command actions")).toBeNull();

    await test.terminalController.receive({
      type: "terminal-view/render-batch",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence: 1,
      operations: [
        {
          type: "block-boundary",
          boundary: "command-start",
          blockId: "host-block-2",
        },
        {
          type: "presentation",
          alternateScreen: false,
          blocks: [
            {
              blockId: "host-block-2",
              decoration: "active",
              actions: [
                "copy-command",
                "copy-output",
                "copy-command-and-output",
                "interrupt-command",
              ],
            },
          ],
        },
      ],
      droppedRenderBytes: 0,
      replayTruncated: false,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    });
    expect(screen.getByLabelText("Command actions")).toBeTruthy();
    expect(screen.getByText("Interrupt")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Interrupt command" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy output" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Copy command and output" }),
    ).toBeNull();

    await test.terminalController.receive({
      type: "terminal-view/render-batch",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence: 2,
      operations: [
        {
          type: "alternate-screen",
          transition: { type: "enter", modes: [1049] },
        },
      ],
      droppedRenderBytes: 0,
      replayTruncated: false,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    });
    expect(
      screen.getByText("Interactive terminal application active"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Interrupt command" }),
    ).toBeNull();

    await test.terminalController.receive({
      type: "terminal-view/render-batch",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      sequence: 3,
      operations: [
        {
          type: "alternate-screen",
          transition: { type: "exit", modes: [1049] },
        },
        {
          type: "presentation",
          alternateScreen: false,
          blocks: [
            {
              blockId: "host-block-2",
              decoration: "completed",
              actions: [
                "copy-command",
                "copy-output",
                "copy-command-and-output",
                "rerun-command",
              ],
            },
          ],
        },
      ],
      droppedRenderBytes: 0,
      replayTruncated: false,
      replayPendingControl: false,
      suppressedOutputCharacters: 0,
      outputPolicyDecisions: [],
    });
    expect(screen.getByRole("button", { name: "Rerun command" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Interrupt command" }),
    ).toBeNull();
  });

  it("renders the native-style terminal list and delegates selection, close, and visibility", async () => {
    const test = controller();
    render(
      <App
        vscodeApi={{ postMessage: test.postMessage }}
        controller={test.terminalController}
      />,
    );
    await test.terminalController.receive({
      type: "terminal-view/bootstrap",
      protocolVersion: 1,
      rendererEpoch: "renderer-1",
      state: {
        tabs: [
          {
            id: "host-1",
            title: "zsh",
            cwd: "/workspace",
            profileName: "zsh",
            dimensions: { columns: 80, rows: 24 },
            status: "running",
          },
          {
            id: "sandbox-1",
            title: "Unit tests",
            channelKind: "agent-sandbox",
            cwd: "/workspace/package",
            profileName: "AgentLink Sandbox",
            dimensions: { columns: 80, rows: 24 },
            status: "running",
          },
        ],
        activeTabId: "host-1",
      },
      configuration: { scrollback: 1000 },
      replay: [
        {
          terminalId: "host-1",
          terminalInstanceId: "host-instance-1",
          sequence: 0,
          data: "",
          byteLength: 0,
          droppedBytes: 0,
          replayTruncated: false,
          replayPendingControl: false,
          blocks: {
            blocks: [],
            currentCwd: "/workspace",
            mode: "raw",
            droppedBlocks: 0,
            nextBlockNumber: 1,
            maxBlockOutputBytes: 1000,
            maxBlocks: 20,
          },
          presentation: {
            alternateScreen: false,
            terminalRunning: true,
            blocks: [],
          },
        },
        {
          terminalId: "sandbox-1",
          terminalInstanceId: "sandbox-instance-1",
          sequence: 0,
          data: "",
          byteLength: 0,
          droppedBytes: 0,
          replayTruncated: false,
          replayPendingControl: false,
          blocks: {
            blocks: [],
            currentCwd: "/workspace/package",
            mode: "raw",
            droppedBlocks: 0,
            nextBlockNumber: 1,
            maxBlockOutputBytes: 1000,
            maxBlocks: 20,
          },
          presentation: {
            alternateScreen: false,
            terminalRunning: true,
            blocks: [],
          },
        },
      ],
    });

    expect(
      screen.getByRole("complementary", { name: "Open terminals" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("2 open terminals")).toBeTruthy();
    const hostButton = screen.getByRole("button", {
      name: "Focus zsh (Host Shell)",
    });
    const sandboxButton = screen.getByRole("button", {
      name: "Focus Unit tests (Sandbox)",
    });
    expect(hostButton.getAttribute("aria-current")).toBe("true");
    expect(sandboxButton.getAttribute("aria-current")).toBeNull();
    expect(hostButton.querySelector(".codicon-terminal")).toBeTruthy();
    expect(
      sandboxButton.querySelector(".codicon-shield.terminal-sandbox-icon"),
    ).toBeTruthy();
    expect(
      sandboxButton.querySelector(".terminal-list-sandbox-badge"),
    ).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Active terminal" }),
    ).toBeNull();

    fireEvent.click(sandboxButton);
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "host-terminal/activate",
      terminalId: "sandbox-1",
      terminalInstanceId: "sandbox-instance-1",
      rendererEpoch: "renderer-1",
    });

    fireEvent.click(screen.getByTitle("Kill Unit tests"));
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "host-terminal/close-intent",
      terminalId: "sandbox-1",
      terminalInstanceId: "sandbox-instance-1",
      rendererEpoch: "renderer-1",
    });

    const listToggle = screen.getByRole("button", {
      name: "Toggle terminal list",
    });
    expect(listToggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(listToggle);
    expect(
      screen.queryByRole("complementary", { name: "Open terminals" }),
    ).toBeNull();
    expect(listToggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(listToggle);
    expect(
      screen.getByRole("complementary", { name: "Open terminals" }),
    ).toBeTruthy();
  });

  it("renders a compact terminal toolbar and delegates on-demand search", async () => {
    const test = controller();
    render(
      <App
        vscodeApi={{ postMessage: test.postMessage }}
        controller={test.terminalController}
      />,
    );
    await test.terminalController.receive({
      type: "terminal-view/bootstrap",
      protocolVersion: 1,
      rendererEpoch: "renderer-1",
      state: {
        tabs: [
          {
            id: "terminal-1",
            title: "zsh",
            cwd: "/workspace",
            profileName: "zsh",
            dimensions: { columns: 80, rows: 24 },
            status: "running",
          },
        ],
        activeTabId: "terminal-1",
      },
      configuration: { scrollback: 1000 },
      replay: [
        {
          terminalId: "terminal-1",
          terminalInstanceId: "instance-1",
          sequence: 0,
          data: "",
          byteLength: 0,
          droppedBytes: 0,
          replayTruncated: false,
          replayPendingControl: false,
          blocks: {
            blocks: [],
            currentCwd: "/workspace",
            mode: "raw",
            droppedBlocks: 0,
            nextBlockNumber: 1,
            maxBlockOutputBytes: 1000,
            maxBlocks: 20,
          },
          presentation: {
            alternateScreen: false,
            terminalRunning: true,
            blocks: [],
          },
        },
      ],
    });

    expect(
      screen.getByRole("button", { name: "Focus zsh (Host Shell)" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("combobox", { name: "Active terminal" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "New Terminal" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Paste into Terminal" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Find in Terminal" }),
    ).toBeTruthy();
    expect(screen.getByTitle("Kill Terminal")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Paste into Terminal" }),
    );
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "host-terminal/paste-intent",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      rendererEpoch: "renderer-1",
    });
    expect(
      screen.queryByRole("textbox", { name: "Search terminal" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Find in Terminal" }));
    const search = screen.getByRole("textbox", { name: "Search terminal" });
    fireEvent.input(search, { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "Next search result" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Previous search result" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Clear terminal search" }),
    );

    expect(test.renderer.findNext).toHaveBeenCalledWith("needle");
    expect(test.renderer.findPrevious).toHaveBeenCalledWith("needle");
    expect(test.renderer.clearSearch).toHaveBeenCalled();
    expect(
      screen.queryByRole("textbox", { name: "Search terminal" }),
    ).toBeNull();

    await test.terminalController.receive({
      type: "terminal-view/confirmation",
      confirmationId: "confirmation-1",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      operation: "paste",
      title: "Paste multiple lines?",
      message: "The clipboard contains multiple lines.",
      confirmLabel: "Paste",
    });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    expect(test.postMessage).toHaveBeenCalledWith({
      type: "terminal-view/confirm",
      terminalId: "terminal-1",
      terminalInstanceId: "instance-1",
      rendererEpoch: "renderer-1",
      confirmationId: "confirmation-1",
      accept: true,
    });
  });
});
