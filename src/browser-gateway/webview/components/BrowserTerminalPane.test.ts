/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

import { BrowserTerminalPane } from "./BrowserTerminalPane";
import type { TerminalBuffer } from "../../../shared/terminalActivity";
import { TerminalViewport } from "./TerminalViewport";
import { h } from "preact";

const xtermWrites = vi.hoisted(() => [] as string[]);

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    private host: HTMLElement | null = null;

    loadAddon() {}

    open(host: HTMLElement) {
      this.host = host;
      const marker = document.createElement("div");
      marker.className = "xterm-mock";
      host.appendChild(marker);
    }

    reset() {
      if (this.host) this.host.textContent = "";
    }

    write(text: string, callback?: () => void) {
      xtermWrites.push(text);
      if (this.host) this.host.textContent = text;
      callback?.();
    }

    scrollToBottom() {}

    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit() {}
  },
}));

const idleBuffer: TerminalBuffer = {
  id: "terminal:default",
  label: "AgentLink",
  lines: [
    {
      id: "terminal:default:cursor",
      kind: "cursor",
      prompt: "agentlink",
      text: "",
      status: "completed",
    },
  ],
  lastStatus: "completed",
  lastUpdatedIndex: -1,
};

const testBuffer: TerminalBuffer = {
  id: "terminal:term_1",
  label: "term_1",
  terminalId: "term_1",
  lines: [
    {
      id: "cmd:command",
      kind: "command",
      prompt: "➜  agentlink git:(main) ✗",
      text: "npm test",
      status: "completed",
    },
    {
      id: "cmd:output:0",
      kind: "output",
      text: "passed",
      status: "completed",
    },
  ],
  lastStatus: "completed",
  lastUpdatedIndex: 0,
};

const secondBuffer: TerminalBuffer = {
  id: "terminal:term_2",
  label: "term_2",
  terminalId: "term_2",
  lines: [
    {
      id: "cmd2:command",
      kind: "command",
      prompt: "agentlink",
      text: "npm run lint",
      status: "running",
    },
    {
      id: "cmd2:status",
      kind: "status",
      text: "running…",
      status: "running",
    },
  ],
  lastStatus: "running",
  lastUpdatedIndex: 1,
};

afterEach(() => {
  cleanup();
  xtermWrites.length = 0;
});

describe("TerminalViewport", () => {
  it("renders prompt, command, output, and idle cursor lines", () => {
    render(h(TerminalViewport, { buffer: testBuffer }));

    expect(screen.getByLabelText("Read-only terminal term_1")).toBeTruthy();
    expect(xtermWrites.at(-1)).toContain("npm test");
    expect(xtermWrites.at(-1)).toContain("passed");
  });

  it("prefers raw terminal chunks when available", async () => {
    render(
      h(TerminalViewport, {
        buffer: {
          ...testBuffer,
          chunks: [
            {
              id: "raw-output-1",
              kind: "raw",
              text: "\u001b[32mraw-green\u001b[0m\rprogress",
              command: "npm test",
              prompt: "➜  agentlink git:(remote-browser-sessions) ✗",
            },
            {
              id: "raw-output-2",
              kind: "raw",
              text: "\nnext",
            },
          ],
        },
      }),
    );

    await waitFor(() => {
      expect(xtermWrites.at(-1)).toBe(
        "\u001b[1;32m➜\u001b[0m \u001b[1;32magentlink\u001b[0m \u001b[1;34mgit:(remote-browser-sessions)\u001b[0m\u001b[1;34m ✗\u001b[0m npm test\r\n\u001b[32mraw-green\u001b[0m\rprogress\nnext",
      );
    });
  });

  it("writes ANSI colored output to xterm", async () => {
    render(
      h(TerminalViewport, {
        buffer: {
          ...testBuffer,
          lines: [
            {
              id: "ansi-output",
              kind: "output",
              text: "\u001b[32mgreen\u001b[0m plain",
            },
          ],
        },
      }),
    );

    await waitFor(() => {
      expect(xtermWrites.at(-1)).toContain("\u001b[32mgreen\u001b[0m plain");
    });
  });

  it("renders an idle prompt for an empty default buffer", () => {
    render(h(TerminalViewport, { buffer: idleBuffer }));

    expect(xtermWrites.at(-1)).toContain("agentlink");
  });
});

describe("BrowserTerminalPane", () => {
  it("renders the terminal instance list and switches selected buffers", () => {
    render(h(BrowserTerminalPane, { buffers: [testBuffer, secondBuffer] }));

    expect(screen.getByLabelText("Terminal instances")).toBeTruthy();
    expect(screen.getByText("term_1")).toBeTruthy();
    expect(screen.getByText("term_2")).toBeTruthy();
    expect(xtermWrites.at(-1)).toContain("npm run lint");

    fireEvent.click(screen.getByRole("button", { name: /term_1/ }));

    expect(xtermWrites.at(-1)).toContain("npm test");
  });

  it("selects a newly added terminal buffer automatically", () => {
    const { rerender } = render(
      h(BrowserTerminalPane, { buffers: [testBuffer] }),
    );

    expect(xtermWrites.at(-1)).toContain("npm test");

    rerender(h(BrowserTerminalPane, { buffers: [testBuffer, secondBuffer] }));

    expect(xtermWrites.at(-1)).toContain("npm run lint");
  });

  it("hides the terminal instance list when requested", () => {
    render(
      h(BrowserTerminalPane, {
        buffers: [testBuffer],
        showInstanceList: false,
      }),
    );

    expect(screen.queryByLabelText("Terminal instances")).toBeNull();
    expect(xtermWrites.at(-1)).toContain("npm test");
  });
});
