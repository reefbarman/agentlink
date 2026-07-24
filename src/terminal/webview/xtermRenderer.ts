import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import {
  Terminal,
  type IBufferLine,
  type IDisposable,
  type ILink,
  type ILinkProvider,
  type IMarker,
  type ITerminalOptions,
  type ITheme,
} from "@xterm/xterm";

import type {
  TerminalRenderer,
  TerminalRendererCallbacks,
  TerminalRendererFactory,
} from "./terminalWebviewController.js";
import {
  type HostTerminalBlockBoundary,
  MAX_TERMINAL_LINK_BYTES,
  type TerminalSurfaceConfiguration,
} from "../terminalSurfaceProtocol.js";

function cssColor(name: string): string | undefined {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    undefined
  );
}

function terminalTheme(): ITheme {
  return {
    background: cssColor("--vscode-terminal-background"),
    foreground: cssColor("--vscode-terminal-foreground"),
    cursor: cssColor("--vscode-terminalCursor-foreground"),
    cursorAccent: cssColor("--vscode-terminalCursor-background"),
    selectionBackground: cssColor("--vscode-terminal-selectionBackground"),
    selectionInactiveBackground: cssColor(
      "--vscode-terminal-inactiveSelectionBackground",
    ),
    selectionForeground: cssColor("--vscode-terminal-selectionForeground"),
    black: cssColor("--vscode-terminal-ansiBlack"),
    red: cssColor("--vscode-terminal-ansiRed"),
    green: cssColor("--vscode-terminal-ansiGreen"),
    yellow: cssColor("--vscode-terminal-ansiYellow"),
    blue: cssColor("--vscode-terminal-ansiBlue"),
    magenta: cssColor("--vscode-terminal-ansiMagenta"),
    cyan: cssColor("--vscode-terminal-ansiCyan"),
    white: cssColor("--vscode-terminal-ansiWhite"),
    brightBlack: cssColor("--vscode-terminal-ansiBrightBlack"),
    brightRed: cssColor("--vscode-terminal-ansiBrightRed"),
    brightGreen: cssColor("--vscode-terminal-ansiBrightGreen"),
    brightYellow: cssColor("--vscode-terminal-ansiBrightYellow"),
    brightBlue: cssColor("--vscode-terminal-ansiBrightBlue"),
    brightMagenta: cssColor("--vscode-terminal-ansiBrightMagenta"),
    brightCyan: cssColor("--vscode-terminal-ansiBrightCyan"),
    brightWhite: cssColor("--vscode-terminal-ansiBrightWhite"),
  };
}

function terminalOptions(
  configuration: TerminalSurfaceConfiguration,
  onLink: (url: string) => void,
): ITerminalOptions {
  return {
    ...configurationOptions(configuration),
    allowTransparency: false,
    linkHandler: {
      activate: (_event, url) => onLink(url),
    },
    theme: terminalTheme(),
  };
}

function configurationOptions(
  configuration: TerminalSurfaceConfiguration,
): ITerminalOptions {
  return {
    scrollback: configuration.scrollback,
    ...(configuration.fontFamily === undefined
      ? {}
      : { fontFamily: configuration.fontFamily }),
    ...(configuration.fontSize === undefined
      ? {}
      : { fontSize: configuration.fontSize }),
    ...(configuration.lineHeight === undefined
      ? {}
      : { lineHeight: configuration.lineHeight }),
    ...(configuration.letterSpacing === undefined
      ? {}
      : { letterSpacing: configuration.letterSpacing }),
    ...(configuration.cursorBlink === undefined
      ? {}
      : { cursorBlink: configuration.cursorBlink }),
    ...(configuration.cursorStyle === undefined
      ? {}
      : {
          cursorStyle:
            configuration.cursorStyle === "line"
              ? ("bar" as const)
              : configuration.cursorStyle,
        }),
    screenReaderMode: configuration.screenReaderMode ?? false,
  };
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

export function terminalCursorKeySequence(
  key: string,
  applicationCursorKeysMode: boolean,
): string | undefined {
  if (key !== "ArrowUp" && key !== "ArrowDown") return undefined;
  return `\x1b${applicationCursorKeysMode ? "O" : "["}${key === "ArrowUp" ? "A" : "B"}`;
}

interface TerminalLineCell {
  readonly textStart: number;
  readonly textEnd: number;
  readonly column: number;
  readonly width: number;
}

export const XTERM_CORE_OSC_HANDLERS = [
  0, 1, 2, 4, 8, 10, 11, 12, 104, 110, 111, 112,
] as const;
export const XTERM_ADDON_OSC_HANDLERS = [] as const;
export const SUPPRESSED_TERMINAL_OSC_HANDLERS = [
  9, 52, 697, 777, 1337,
] as const;

const HTTP_LINK_PATTERN = /https?:\/\/[^\s\p{Cc}<>"'`\\]+/giu;
const TRAILING_LINK_PUNCTUATION = /[.,;:!?]/u;
const textEncoder = new TextEncoder();

function trimTerminalLinkCandidate(candidate: string): string {
  let end = candidate.length;
  while (end > 0) {
    const character = candidate[end - 1];
    if (TRAILING_LINK_PUNCTUATION.test(character)) {
      end -= 1;
      continue;
    }
    const opener = character === ")" ? "(" : character === "]" ? "[" : "{";
    if (character !== ")" && character !== "]" && character !== "}") break;
    const value = candidate.slice(0, end);
    const openCount = [...value].filter((value) => value === opener).length;
    const closeCount = [...value].filter((value) => value === character).length;
    if (closeCount <= openCount) break;
    end -= 1;
  }
  return candidate.slice(0, end);
}

function terminalLineText(
  line: IBufferLine,
  columns: number,
): {
  text: string;
  cells: readonly TerminalLineCell[];
} {
  const cells: TerminalLineCell[] = [];
  let text = "";
  for (let column = 0; column < Math.min(line.length, columns); column += 1) {
    const cell = line.getCell(column);
    const width = cell?.getWidth() ?? 1;
    if (width === 0) continue;
    const characters = cell?.getChars() || " ";
    const textStart = text.length;
    text += characters;
    cells.push({
      textStart,
      textEnd: text.length,
      column,
      width,
    });
  }
  return { text, cells };
}

export function detectTerminalHttpLinks(
  line: IBufferLine,
  bufferLineNumber: number,
  columns: number,
  onLink: (url: string) => void,
): readonly ILink[] {
  const { text, cells } = terminalLineText(line, columns);
  const links: ILink[] = [];
  HTTP_LINK_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(HTTP_LINK_PATTERN)) {
    const matchStart = match.index;
    if (matchStart > 0 && /[\p{L}\p{N}_+.:-]/u.test(text[matchStart - 1])) {
      continue;
    }
    const candidate = trimTerminalLinkCandidate(match[0]);
    if (
      !candidate ||
      textEncoder.encode(candidate).byteLength > MAX_TERMINAL_LINK_BYTES
    ) {
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;

    const matchEnd = matchStart + candidate.length;
    const firstCell = cells.find(
      (cell) => matchStart >= cell.textStart && matchStart < cell.textEnd,
    );
    const lastCell = cells.find(
      (cell) => matchEnd > cell.textStart && matchEnd <= cell.textEnd,
    );
    if (!firstCell || !lastCell) continue;
    links.push({
      text: candidate,
      range: {
        start: { x: firstCell.column + 1, y: bufferLineNumber },
        end: {
          x: lastCell.column + lastCell.width,
          y: bufferLineNumber,
        },
      },
      activate: () => onLink(candidate),
    });
  }
  return links;
}

export function registerTerminalOscDefenses(terminal: Terminal): IDisposable {
  const subscriptions = SUPPRESSED_TERMINAL_OSC_HANDLERS.map((command) =>
    terminal.parser.registerOscHandler(command, (data) => {
      if (command !== 9) return true;
      const operation = data.split(";", 1)[0];
      return operation !== "4" && operation !== "9";
    }),
  );
  return {
    dispose() {
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}

function isColorQuery(command: number, data: string): boolean {
  const values = data.split(";");
  return command === 4
    ? values.some((value, index) => index % 2 === 1 && value === "?")
    : values.includes("?");
}

const REPLAY_RESPONSE_CSI_HANDLERS = [
  { final: "c" },
  { prefix: ">", final: "c" },
  { final: "n" },
  { prefix: "?", final: "n" },
  { intermediates: "$", final: "p" },
  { prefix: "?", intermediates: "$", final: "p" },
] as const;

const WINDOW_REPORT_PARAMETERS = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21]);

export function registerReplayResponseSuppression(
  terminal: Terminal,
): IDisposable {
  const subscriptions: IDisposable[] = [4, 10, 11, 12].map((command) =>
    terminal.parser.registerOscHandler(command, (data) =>
      isColorQuery(command, data),
    ),
  );
  subscriptions.push(
    ...REPLAY_RESPONSE_CSI_HANDLERS.map((identifier) =>
      terminal.parser.registerCsiHandler(identifier, () => true),
    ),
    terminal.parser.registerCsiHandler({ final: "t" }, (params) =>
      WINDOW_REPORT_PARAMETERS.has(Number(params[0])),
    ),
    terminal.parser.registerDcsHandler(
      { intermediates: "$", final: "q" },
      () => true,
    ),
  );
  return {
    dispose() {
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}

export function computeStickyBlockId(
  markers: ReadonlyMap<string, Pick<IMarker, "line" | "isDisposed">>,
  viewportTopLine: number,
): string | undefined {
  let stickyBlockId: string | undefined;
  let stickyLine = -1;
  for (const [blockId, marker] of markers) {
    if (marker.isDisposed || marker.line >= viewportTopLine) continue;
    // ">=" lets a same-line marker registered later win, matching block order.
    if (marker.line >= stickyLine) {
      stickyLine = marker.line;
      stickyBlockId = blockId;
    }
  }
  return stickyBlockId;
}

function createTerminalHttpLinkProvider(
  terminal: Terminal,
  onLink: (url: string) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const links = detectTerminalHttpLinks(
        line,
        bufferLineNumber,
        terminal.cols,
        onLink,
      );
      callback(links.length > 0 ? [...links] : undefined);
    },
  };
}

export function interceptTerminalInputTransfer(
  container: HTMLElement,
  onPaste: () => void,
  signal: AbortSignal,
): void {
  const stopTransfer = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  container.addEventListener(
    "paste",
    (event) => {
      stopTransfer(event);
      onPaste();
    },
    { capture: true, signal },
  );
  container.addEventListener("dragover", stopTransfer, {
    capture: true,
    signal,
  });
  container.addEventListener("drop", stopTransfer, {
    capture: true,
    signal,
  });
}

class XtermRenderer implements TerminalRenderer {
  private readonly terminal: Terminal;
  private readonly fitAddon = new FitAddon();
  private readonly searchAddon = new SearchAddon();
  private readonly subscriptions: IDisposable[] = [];
  private readonly blockMarkers = new Map<string, IMarker>();
  private readonly abortController = new AbortController();
  private readonly ariaLabel: string;
  private readonly callbacks: TerminalRendererCallbacks;
  private lastStickyBlockId: string | undefined;

  constructor(
    configuration: TerminalSurfaceConfiguration,
    callbacks: TerminalRendererCallbacks,
  ) {
    this.ariaLabel = callbacks.ariaLabel;
    this.callbacks = callbacks;
    this.terminal = new Terminal(
      terminalOptions(configuration, callbacks.onLink),
    );
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    // Keep history navigation deterministic in VS Code webviews. The xterm 5.5
    // default key path can produce an empty data event for plain Up/Down there.
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.type !== "keydown" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return true;
      }
      const sequence = terminalCursorKeySequence(
        event.key,
        this.terminal.modes.applicationCursorKeysMode,
      );
      if (!sequence) return true;
      event.preventDefault();
      event.stopPropagation();
      callbacks.onData(sequence);
      return false;
    });
    this.subscriptions.push(
      this.terminal.onData(callbacks.onData),
      this.terminal.onScroll(() => this.notifyStickyBlock()),
      this.terminal.registerLinkProvider(
        createTerminalHttpLinkProvider(this.terminal, callbacks.onLink),
      ),
      registerTerminalOscDefenses(this.terminal),
    );
  }

  open(container: HTMLElement): void {
    this.terminal.open(container);
    this.terminal.textarea?.setAttribute("aria-label", this.ariaLabel);
    interceptTerminalInputTransfer(
      container,
      () => this.callbacks.onPaste(this.terminal.modes.bracketedPasteMode),
      this.abortController.signal,
    );
  }

  async write(data: string, source: "live" | "replay" = "live"): Promise<void> {
    if (source === "live") {
      await write(this.terminal, data);
      this.notifyStickyBlock();
      return;
    }
    const suppression = registerReplayResponseSuppression(this.terminal);
    try {
      await write(this.terminal, data);
    } finally {
      suppression.dispose();
    }
    this.notifyStickyBlock();
  }

  reset(): void {
    this.disposeBlockMarkers();
    this.terminal.reset();
    this.notifyStickyBlock();
  }

  focus(): void {
    this.terminal.focus();
  }

  fit() {
    const dimensions = this.fitAddon.proposeDimensions();
    if (!dimensions) return undefined;
    if (
      dimensions.cols !== this.terminal.cols ||
      dimensions.rows !== this.terminal.rows
    ) {
      this.fitAddon.fit();
    }
    return { columns: dimensions.cols, rows: dimensions.rows };
  }

  findNext(term: string): boolean {
    return this.searchAddon.findNext(term, { incremental: true });
  }

  findPrevious(term: string): boolean {
    return this.searchAddon.findPrevious(term);
  }

  clearSearch(): void {
    this.searchAddon.clearDecorations();
    this.terminal.clearSelection();
  }

  isBracketedPasteMode(): boolean {
    return this.terminal.modes.bracketedPasteMode;
  }

  registerBlockBoundary(
    blockId: string,
    _boundary: HostTerminalBlockBoundary,
  ): boolean {
    if (this.blockMarkers.has(blockId)) return true;
    const marker = this.terminal.registerMarker();
    if (!marker) return false;
    this.blockMarkers.set(blockId, marker);
    marker.onDispose(() => {
      if (this.blockMarkers.get(blockId) !== marker) return;
      this.blockMarkers.delete(blockId);
      this.callbacks.onBlockAnchorDisposed(blockId);
      this.notifyStickyBlock();
    });
    this.notifyStickyBlock();
    return true;
  }

  retainBlockAnchors(blockIds: ReadonlySet<string>): void {
    for (const [blockId, marker] of this.blockMarkers) {
      if (blockIds.has(blockId)) continue;
      this.blockMarkers.delete(blockId);
      marker.dispose();
    }
    this.notifyStickyBlock();
  }

  scrollToBlock(blockId: string): boolean {
    const marker = this.blockMarkers.get(blockId);
    if (!marker || marker.isDisposed) return false;
    this.terminal.scrollToLine(marker.line);
    this.notifyStickyBlock();
    return true;
  }

  updateConfiguration(configuration: TerminalSurfaceConfiguration): void {
    Object.assign(this.terminal.options, configurationOptions(configuration), {
      theme: terminalTheme(),
    });
  }

  dispose(): void {
    this.abortController.abort();
    this.disposeBlockMarkers();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.terminal.dispose();
  }

  private disposeBlockMarkers(): void {
    const markers = [...this.blockMarkers.values()];
    this.blockMarkers.clear();
    for (const marker of markers) marker.dispose();
  }

  private notifyStickyBlock(): void {
    const stickyBlockId = computeStickyBlockId(
      this.blockMarkers,
      this.terminal.buffer.active.viewportY,
    );
    if (stickyBlockId === this.lastStickyBlockId) return;
    this.lastStickyBlockId = stickyBlockId;
    this.callbacks.onStickyBlockChanged(stickyBlockId);
  }
}

export const xtermRendererFactory: TerminalRendererFactory = {
  create(configuration, callbacks) {
    return new XtermRenderer(configuration, callbacks);
  },
};
