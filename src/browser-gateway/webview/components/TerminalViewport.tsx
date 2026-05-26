import type {
  TerminalBuffer,
  TerminalBufferLine,
} from "../../../shared/terminalActivity";
import { useEffect, useRef } from "preact/hooks";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";

interface TerminalViewportProps {
  buffer: TerminalBuffer;
  sessionId?: string | null;
}

const ESC = String.fromCharCode(27);
const DEFAULT_TERMINAL_FONT_FAMILY =
  '"Cascadia Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
const DEFAULT_TERMINAL_FONT_SIZE = /Mac/i.test(navigator.platform) ? 12 : 14;

type BrowserTerminalFontOptions = Pick<
  ITerminalOptions,
  "fontFamily" | "fontSize" | "fontWeight" | "letterSpacing" | "lineHeight"
>;

function colorToken(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

function cssToken(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

function numberToken(name: string, fallback: number): number {
  const value = Number.parseFloat(cssToken(name, ""));
  return Number.isFinite(value) ? value : fallback;
}

function fontWeightToken(
  name: string,
  fallback: NonNullable<ITerminalOptions["fontWeight"]>,
): ITerminalOptions["fontWeight"] {
  const value = cssToken(name, "");
  if (!value) return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric))
    return numeric as ITerminalOptions["fontWeight"];
  return value as ITerminalOptions["fontWeight"];
}

function terminalFontOptions(): BrowserTerminalFontOptions {
  return {
    fontFamily: cssToken(
      "--vscode-terminal-fontFamily",
      DEFAULT_TERMINAL_FONT_FAMILY,
    ),
    fontSize: numberToken(
      "--vscode-terminal-fontSize",
      DEFAULT_TERMINAL_FONT_SIZE,
    ),
    fontWeight: fontWeightToken("--vscode-terminal-fontWeight", "normal"),
    letterSpacing: numberToken("--vscode-terminal-letterSpacing", 0),
    lineHeight: numberToken("--vscode-terminal-lineHeight", 1),
  };
}

function ensureMatchMedia(): void {
  if (typeof window === "undefined") return;
  const maybeWindow = window as unknown as Record<string, unknown>;
  if (typeof maybeWindow.matchMedia === "function") return;
  maybeWindow.matchMedia = (() => ({
    matches: false,
    media: "",
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as Window["matchMedia"];
}

function terminalTheme(): ITerminalOptions["theme"] {
  return {
    background: colorToken("--ag-terminal-bg", "#1e1e1e"),
    foreground: colorToken("--ag-terminal-fg", "#cccccc"),
    cursor: colorToken("--ag-terminal-cursor", "#aeafad"),
    cursorAccent: colorToken("--ag-terminal-cursor-accent", "#1e1e1e"),
    selectionBackground: colorToken(
      "--ag-terminal-selection-bg",
      "rgba(255, 255, 255, 0.25)",
    ),
    selectionInactiveBackground: colorToken(
      "--ag-terminal-selection-inactive-bg",
      "rgba(255, 255, 255, 0.15)",
    ),
    black: colorToken("--ag-terminal-black", "#000000"),
    red: colorToken("--ag-terminal-red", "#cd3131"),
    green: colorToken("--ag-terminal-green", "#0dbc79"),
    yellow: colorToken("--ag-terminal-yellow", "#e5e510"),
    blue: colorToken("--ag-terminal-blue", "#2472c8"),
    magenta: colorToken("--ag-terminal-magenta", "#bc3fbc"),
    cyan: colorToken("--ag-terminal-cyan", "#11a8cd"),
    white: colorToken("--ag-terminal-white", "#e5e5e5"),
    brightBlack: colorToken("--ag-terminal-bright-black", "#666666"),
    brightRed: colorToken("--ag-terminal-bright-red", "#f14c4c"),
    brightGreen: colorToken("--ag-terminal-bright-green", "#23d18b"),
    brightYellow: colorToken("--ag-terminal-bright-yellow", "#f5f543"),
    brightBlue: colorToken("--ag-terminal-bright-blue", "#3b8eea"),
    brightMagenta: colorToken("--ag-terminal-bright-magenta", "#d670d6"),
    brightCyan: colorToken("--ag-terminal-bright-cyan", "#29b8db"),
    brightWhite: colorToken("--ag-terminal-bright-white", "#ffffff"),
  };
}

function applyTerminalOptions(terminal: Terminal): void {
  terminal.options = {
    ...terminalFontOptions(),
    theme: terminalTheme(),
  };
}

function createTerminal(): Terminal {
  ensureMatchMedia();
  return new Terminal({
    allowProposedApi: false,
    convertEol: true,
    cursorBlink: true,
    cursorInactiveStyle: "outline",
    cursorStyle: "block",
    disableStdin: true,
    drawBoldTextInBrightColors: true,
    minimumContrastRatio: 4.5,
    scrollOnEraseInDisplay: true,
    ...terminalFontOptions(),
    scrollback: 10_000,
    theme: terminalTheme(),
  });
}

function ohMyZshPrompt(prompt: string): string {
  const match = /^➜\s+(.+?)\s+git:\((.+?)\)(.*)$/.exec(prompt);
  if (!match) return `${prompt} `;

  return [
    `${ESC}[1;32m➜${ESC}[0m`,
    ` ${ESC}[1;32m${match[1]}${ESC}[0m`,
    ` ${ESC}[1;34mgit:(${match[2]})${ESC}[0m`,
    match[3] ? `${ESC}[1;34m${match[3]}${ESC}[0m` : "",
    " ",
  ].join("");
}

function statusText(line: TerminalBufferLine): string {
  if (line.status === "running") return `${ESC}[3;90m${line.text}${ESC}[0m`;
  if (line.status === "warning") return `${ESC}[33m${line.text}${ESC}[0m`;
  if (line.status === "error") return `${ESC}[31m${line.text}${ESC}[0m`;
  return line.text;
}

function rawChunkText(buffer: TerminalBuffer): string | undefined {
  if (!buffer.chunks?.length) return undefined;

  return buffer.chunks
    .map((chunk) => {
      const commandLine = chunk.command
        ? `${ohMyZshPrompt(chunk.prompt ?? "➜  agentlink git:(main) ✗")}${chunk.command}\r\n`
        : "";
      return `${commandLine}${chunk.text}`;
    })
    .join("");
}

function terminalText(buffer: TerminalBuffer): string {
  const rawText = rawChunkText(buffer);
  if (rawText !== undefined) return rawText;

  return buffer.lines
    .map((line) => {
      if (line.kind === "command") {
        return `${ohMyZshPrompt(line.prompt ?? "➜  agentlink git:(main) ✗")}${line.text}`;
      }
      if (line.kind === "cursor") {
        return ohMyZshPrompt(line.prompt ?? "➜  agentlink git:(main) ✗");
      }
      if (line.kind === "status") {
        return statusText(line);
      }
      return line.text;
    })
    .join("\r\n");
}

export function TerminalViewport({ buffer, sessionId }: TerminalViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const text = terminalText(buffer);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = createTerminal();
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        // xterm can throw while hidden or before layout has dimensions.
      }
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    resizeObserver?.observe(host);

    let optionsUpdateRaf: number | null = null;
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            if (optionsUpdateRaf !== null) return;
            optionsUpdateRaf = requestAnimationFrame(() => {
              optionsUpdateRaf = null;
              applyTerminalOptions(terminal);
              fit();
            });
          });
    mutationObserver?.observe(document.documentElement, {
      attributeFilter: ["style"],
      attributes: true,
    });

    requestAnimationFrame(fit);

    return () => {
      if (optionsUpdateRaf !== null) cancelAnimationFrame(optionsUpdateRaf);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.reset();
    terminal.write(text, () => {
      try {
        terminal.scrollToBottom();
      } catch {
        // xterm can lack dimensions in test/hidden layouts.
      }
    });
  }, [buffer.id, sessionId, text]);

  return (
    <div
      ref={hostRef}
      class="browser-terminal-viewport"
      role="log"
      aria-label={`Read-only terminal ${buffer.label}`}
    />
  );
}
