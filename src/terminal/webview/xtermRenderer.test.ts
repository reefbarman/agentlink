/** @vitest-environment jsdom */

import {
  Terminal,
  type IBufferCell,
  type IBufferLine,
  type ILinkProvider,
  type IMarker,
} from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";

import type { TerminalRendererCallbacks } from "./terminalWebviewController.js";
import {
  detectTerminalHttpLinks,
  interceptTerminalInputTransfer,
  registerReplayResponseSuppression,
  registerTerminalOscDefenses,
  SUPPRESSED_TERMINAL_OSC_HANDLERS,
  terminalCursorKeySequence,
  XTERM_ADDON_OSC_HANDLERS,
  XTERM_CORE_OSC_HANDLERS,
  xtermRendererFactory,
} from "./xtermRenderer.js";
import { MAX_TERMINAL_LINK_BYTES } from "../terminalSurfaceProtocol.js";

function bufferLine(
  cells: readonly { characters: string; width?: number }[],
): IBufferLine {
  return {
    isWrapped: false,
    length: cells.reduce((length, cell) => length + (cell.width ?? 1), 0),
    getCell: vi.fn((column: number) => {
      let cellColumn = 0;
      for (const cell of cells) {
        const width = cell.width ?? 1;
        if (column === cellColumn) {
          return {
            getChars: () => cell.characters,
            getWidth: () => width,
          } as IBufferCell;
        }
        if (column > cellColumn && column < cellColumn + width) {
          return {
            getChars: () => "",
            getWidth: () => 0,
          } as IBufferCell;
        }
        cellColumn += width;
      }
      return undefined;
    }),
    translateToString: vi.fn(),
  };
}

function lineFromText(text: string): IBufferLine {
  return bufferLine([...text].map((characters) => ({ characters })));
}

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function callbacks(onBlockAnchorDisposed = vi.fn()): TerminalRendererCallbacks {
  return {
    ariaLabel: "Test terminal",
    onBlockAnchorDisposed,
    onData: vi.fn(),
    onLink: vi.fn(),
    onPaste: vi.fn(),
  };
}

describe("detectTerminalHttpLinks", () => {
  it("finds bounded http links and trims sentence punctuation", () => {
    const onLink = vi.fn();
    const links = detectTerminalHttpLinks(
      lineFromText(
        "See https://example.com/path?q=1, then HTTP://example.org/docs).",
      ),
      4,
      80,
      onLink,
    );

    expect(links.map(({ text, range }) => ({ text, range }))).toEqual([
      {
        text: "https://example.com/path?q=1",
        range: { start: { x: 5, y: 4 }, end: { x: 32, y: 4 } },
      },
      {
        text: "HTTP://example.org/docs",
        range: { start: { x: 40, y: 4 }, end: { x: 62, y: 4 } },
      },
    ]);
    links[0].activate(new MouseEvent("click"), links[0].text);
    expect(onLink).toHaveBeenCalledWith("https://example.com/path?q=1");
  });

  it("maps string matches to xterm cells after wide and combined characters", () => {
    const links = detectTerminalHttpLinks(
      bufferLine([
        { characters: "界", width: 2 },
        { characters: "e\u0301" },
        { characters: " " },
        ...[..."https://example.com"].map((characters) => ({ characters })),
      ]),
      2,
      80,
      vi.fn(),
    );

    expect(links[0].range).toEqual({
      start: { x: 5, y: 2 },
      end: { x: 23, y: 2 },
    });
  });

  it("rejects unsupported, embedded, malformed, and over-limit candidates", () => {
    const overLimit = `https://example.com/${"x".repeat(MAX_TERMINAL_LINK_BYTES)}`;
    const links = detectTerminalHttpLinks(
      lineFromText(
        [
          "file:///etc/passwd",
          "javascript:https://example.com/embedded",
          "https://[invalid",
          overLimit,
          "https://safe.example/path_(one)",
        ].join(" "),
      ),
      1,
      20_000,
      vi.fn(),
    );

    expect(links.map((link) => link.text)).toEqual([
      "https://safe.example/path_(one)",
    ]);
  });
});

describe("terminal OSC defenses", () => {
  it("pins the audited xterm core, addon, and suppressed OSC inventories", () => {
    expect(XTERM_CORE_OSC_HANDLERS).toEqual([
      0, 1, 2, 4, 8, 10, 11, 12, 104, 110, 111, 112,
    ]);
    expect(XTERM_ADDON_OSC_HANDLERS).toEqual([]);
    expect(SUPPRESSED_TERMINAL_OSC_HANDLERS).toEqual([9, 52, 697, 777, 1337]);
  });

  it("consumes host-effect OSC before earlier xterm handlers can act", async () => {
    const terminal = new Terminal();
    const privilegedHandlers = new Map<number, ReturnType<typeof vi.fn>>();
    for (const command of SUPPRESSED_TERMINAL_OSC_HANDLERS) {
      const handler = vi.fn(() => true);
      privilegedHandlers.set(command, handler);
      terminal.parser.registerOscHandler(command, handler);
    }
    const defenses = registerTerminalOscDefenses(terminal);

    await writeTerminal(
      terminal,
      [
        "\x1b]9;notification\x07",
        "\x1b]52;c;c2VjcmV0\x1b\\",
        "\x1b]697;AgentLink;foreign;A\x07",
        "\x9d777;notify;title;body\x9c",
        "\x1b]1337;File=name=test:data\x07",
      ].join(""),
    );

    for (const handler of privilegedHandlers.values()) {
      expect(handler).not.toHaveBeenCalled();
    }
    defenses.dispose();
    terminal.dispose();
  });

  it("allows non-notification OSC 9 controls to fall through", async () => {
    const terminal = new Terminal();
    const earlierHandler = vi.fn(() => true);
    terminal.parser.registerOscHandler(9, earlierHandler);
    const defenses = registerTerminalOscDefenses(terminal);

    await writeTerminal(terminal, "\x1b]9;4;1;50\x07\x1b]9;9;/workspace\x1b\\");

    expect(earlierHandler).toHaveBeenNthCalledWith(1, "4;1;50");
    expect(earlierHandler).toHaveBeenNthCalledWith(2, "9;/workspace");
    defenses.dispose();
    terminal.dispose();
  });

  it("removes all consuming handlers when the renderer defense is disposed", async () => {
    const terminal = new Terminal();
    const earlierHandler = vi.fn(() => true);
    terminal.parser.registerOscHandler(52, earlierHandler);
    const defenses = registerTerminalOscDefenses(terminal);
    defenses.dispose();

    await writeTerminal(terminal, "\x1b]52;c;c2VjcmV0\x07");

    expect(earlierHandler).toHaveBeenCalledWith("c;c2VjcmV0");
    terminal.dispose();
  });
});

describe("xtermRendererFactory", () => {
  it("encodes normal and application cursor Up and Down sequences", () => {
    expect(terminalCursorKeySequence("ArrowUp", false)).toBe("\x1b[A");
    expect(terminalCursorKeySequence("ArrowDown", false)).toBe("\x1b[B");
    expect(terminalCursorKeySequence("ArrowUp", true)).toBe("\x1bOA");
    expect(terminalCursorKeySequence("ArrowDown", true)).toBe("\x1bOB");
    expect(terminalCursorKeySequence("ArrowLeft", false)).toBeUndefined();
  });

  it("forwards Up and Down arrow key sequences from xterm", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      })),
    );
    const rendererCallbacks = callbacks();
    const renderer = xtermRendererFactory.create(
      { scrollback: 1000 },
      rendererCallbacks,
    );
    const container = document.createElement("div");
    document.body.append(container);
    renderer.open(container);
    const textarea = container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("expected xterm textarea");
    }
    vi.mocked(rendererCallbacks.onData).mockClear();
    const keydown = (key: string, keyCode: number) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "keyCode", { value: keyCode });
      Object.defineProperty(event, "which", { value: keyCode });
      textarea.dispatchEvent(event);
      return event;
    };

    const arrowUp = keydown("ArrowUp", 38);
    const arrowDown = keydown("ArrowDown", 40);

    expect(arrowUp.defaultPrevented).toBe(true);
    expect(arrowDown.defaultPrevented).toBe(true);
    expect(rendererCallbacks.onData).toHaveBeenCalledTimes(2);
    expect(["\x1b[A", "\x1bOA"]).toContain(
      vi.mocked(rendererCallbacks.onData).mock.calls[0]?.[0],
    );
    expect(["\x1b[B", "\x1bOB"]).toContain(
      vi.mocked(rendererCallbacks.onData).mock.calls[1]?.[0],
    );
    renderer.dispose();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("suppresses terminal replies only while replay is active", async () => {
    const terminal = new Terminal();
    const data = vi.fn();
    terminal.onData(data);
    const queries = [
      "\x1b]11;?\x1b\\",
      "\x1b[6n",
      "\x1b[?6n",
      "\x1b[c",
      "\x1b[>c",
      "\x1b[4$p",
      "\x1b[?25$p",
      "\x1bP$qm\x1b\\",
    ].join("");

    const suppression = registerReplayResponseSuppression(terminal);
    await writeTerminal(terminal, queries);
    expect(data).not.toHaveBeenCalled();

    await writeTerminal(terminal, "\x1b[2J");
    expect(data).not.toHaveBeenCalled();

    suppression.dispose();
    await writeTerminal(terminal, queries);
    expect(data).toHaveBeenCalled();
    terminal.dispose();
  });

  it("suppresses window reports during replay", async () => {
    const terminal = new Terminal({
      windowOptions: { getWinSizeChars: true },
    });
    const data = vi.fn();
    terminal.onData(data);
    const suppression = registerReplayResponseSuppression(terminal);

    await writeTerminal(terminal, "\x1b[18t");
    expect(data).not.toHaveBeenCalled();

    suppression.dispose();
    await writeTerminal(terminal, "\x1b[18t");
    expect(data.mock.calls[0]?.[0]).toBe("\x1b[8;24;80t");
    terminal.dispose();
  });

  it("suppresses indexed queries in mixed OSC 4 replay commands", async () => {
    const terminal = new Terminal();
    const colorHandler = vi.fn(() => true);
    terminal.parser.registerOscHandler(4, colorHandler);
    const suppression = registerReplayResponseSuppression(terminal);

    await writeTerminal(terminal, "\x1b]4;1;#112233;2;?\x1b\\");
    expect(colorHandler).not.toHaveBeenCalled();

    await writeTerminal(terminal, "\x1b]4;1;#112233;2;#445566\x1b\\");
    expect(colorHandler).toHaveBeenCalledOnce();
    suppression.dispose();
    terminal.dispose();
  });

  it("registers the stable http link provider and disposes it with the renderer", () => {
    let provider: ILinkProvider | undefined;
    const dispose = vi.fn();
    const registerLinkProvider = vi
      .spyOn(Terminal.prototype, "registerLinkProvider")
      .mockImplementation((value) => {
        provider = value;
        return { dispose };
      });
    const rendererCallbacks = callbacks();
    const renderer = xtermRendererFactory.create(
      { scrollback: 1000 },
      rendererCallbacks,
    );

    expect(registerLinkProvider).toHaveBeenCalledOnce();
    expect(provider).toBeDefined();
    renderer.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("registers stable block markers once and prunes them to host-retained IDs", () => {
    let disposeListener: (() => void) | undefined;
    const marker = {
      id: 1,
      line: 0,
      isDisposed: false,
      onDispose: vi.fn((listener: () => void) => {
        disposeListener = listener;
        return { dispose: vi.fn() };
      }),
      dispose: vi.fn(() => disposeListener?.()),
    } as unknown as IMarker;
    const registerMarker = vi
      .spyOn(Terminal.prototype, "registerMarker")
      .mockReturnValue(marker);
    const onBlockAnchorDisposed = vi.fn();
    const renderer = xtermRendererFactory.create(
      { scrollback: 1000 },
      callbacks(onBlockAnchorDisposed),
    );

    expect(renderer.registerBlockBoundary("block-1", "command-start")).toBe(
      true,
    );
    expect(renderer.registerBlockBoundary("block-1", "command-end")).toBe(true);
    expect(registerMarker).toHaveBeenCalledTimes(1);

    renderer.retainBlockAnchors(new Set());
    expect(marker.dispose).toHaveBeenCalledOnce();
    expect(onBlockAnchorDisposed).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it("notifies the controller when xterm scrollback disposes a live marker", () => {
    let disposeListener: (() => void) | undefined;
    const marker = {
      id: 1,
      line: 0,
      isDisposed: false,
      onDispose: vi.fn((listener: () => void) => {
        disposeListener = listener;
        return { dispose: vi.fn() };
      }),
      dispose: vi.fn(),
    } as unknown as IMarker;
    vi.spyOn(Terminal.prototype, "registerMarker").mockReturnValue(marker);
    const onBlockAnchorDisposed = vi.fn();
    const renderer = xtermRendererFactory.create(
      { scrollback: 1000 },
      callbacks(onBlockAnchorDisposed),
    );
    renderer.registerBlockBoundary("block-1", "command-start");

    disposeListener?.();

    expect(onBlockAnchorDisposed).toHaveBeenCalledWith("block-1");
    renderer.dispose();
  });
});

describe("interceptTerminalInputTransfer", () => {
  it("stops native paste before later xterm handlers and removes itself on abort", () => {
    const container = document.createElement("div");
    const onPaste = vi.fn();
    const laterHandler = vi.fn();
    const abortController = new AbortController();
    interceptTerminalInputTransfer(container, onPaste, abortController.signal);
    container.addEventListener("paste", laterHandler);

    const intercepted = new Event("paste", { bubbles: true, cancelable: true });
    container.dispatchEvent(intercepted);

    expect(intercepted.defaultPrevented).toBe(true);
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(laterHandler).not.toHaveBeenCalled();

    abortController.abort();
    const afterAbort = new Event("paste", { bubbles: true, cancelable: true });
    container.dispatchEvent(afterAbort);
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(laterHandler).toHaveBeenCalledTimes(1);
  });

  it.each(["dragover", "drop"])(
    "blocks native %s input without reading clipboard data",
    (eventType) => {
      const container = document.createElement("div");
      const onPaste = vi.fn();
      const laterHandler = vi.fn();
      const abortController = new AbortController();
      interceptTerminalInputTransfer(
        container,
        onPaste,
        abortController.signal,
      );
      container.addEventListener(eventType, laterHandler);

      const event = new Event(eventType, { bubbles: true, cancelable: true });
      container.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(onPaste).not.toHaveBeenCalled();
      expect(laterHandler).not.toHaveBeenCalled();
    },
  );
});
