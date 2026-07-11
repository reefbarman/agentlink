export interface TerminalCompletionDisposable {
  dispose(): void;
}

export interface TerminalEndEvent<TTerminal, TExecution> {
  terminal: TTerminal;
  execution: TExecution;
  exitCode: number | undefined;
}

export interface TerminalCompletionListenerOptions<TTerminal, TExecution> {
  terminal: TTerminal;
  getExecution(): TExecution | undefined;
  allowTerminalFallback?: boolean;
  subscribeEnd(
    listener: (event: TerminalEndEvent<TTerminal, TExecution>) => void,
  ): TerminalCompletionDisposable;
  subscribeClose(
    listener: (terminal: TTerminal) => void,
  ): TerminalCompletionDisposable;
  onEnd(exitCode: number | undefined): void;
  onClose(): void;
}

export function registerTerminalCompletionListeners<TTerminal, TExecution>(
  options: TerminalCompletionListenerOptions<TTerminal, TExecution>,
): TerminalCompletionDisposable[] {
  const endDisposable = options.subscribeEnd((event) => {
    const execution = options.getExecution();
    if (
      (execution && event.execution === execution) ||
      (!execution &&
        options.allowTerminalFallback &&
        event.terminal === options.terminal)
    ) {
      options.onEnd(event.exitCode);
    }
  });
  const closeDisposable = options.subscribeClose((terminal) => {
    if (terminal === options.terminal) {
      options.onClose();
    }
  });
  return [endDisposable, closeDisposable];
}

const MARKER_POLL_MS = 500;

/** OSC 633;D completion marker emitted by VS Code shell integration. */
// oxlint-disable-next-line no-control-regex -- intentionally matching ANSI escape sequences
const MARKER_RE = /\x1b\]633;D(?:;(\d+))?(?:\x07|\x1b\\)/;

/** Prompt-start markers emitted when the shell has returned to an interactive prompt. */
// oxlint-disable-next-line no-control-regex -- intentionally matching ANSI escape sequences
const PROMPT_MARKER_RE = /\x1b\](?:633|133);A(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/;

// oxlint-disable-next-line no-control-regex -- intentionally matching terminal control chars
const INTERRUPTED_TAIL_RE = /(?:\^C|\x03)\s*$/;

export type ShellCompletionMarker = {
  exitCode: number | null;
  stripped: string;
  source: "exit" | "prompt";
};

export function findAndStripTerminalMarker(
  buffer: string,
  fromPos: number,
): ShellCompletionMarker | undefined {
  const searchFrom = Math.max(0, fromPos - 20);
  const region = buffer.slice(searchFrom);
  const exitMatch = MARKER_RE.exec(region);
  const promptMatch = PROMPT_MARKER_RE.exec(region);
  if (!exitMatch && !promptMatch) return undefined;

  const exitIdx = exitMatch ? searchFrom + exitMatch.index : undefined;
  const promptIdx = promptMatch ? searchFrom + promptMatch.index : undefined;
  const useExit =
    exitIdx !== undefined && (promptIdx === undefined || exitIdx <= promptIdx);
  const match = useExit ? exitMatch! : promptMatch!;
  const markerIdx = useExit ? exitIdx! : promptIdx!;
  const stripped = markerIdx >= 0 ? buffer.slice(0, markerIdx) : buffer;
  const exitCode = useExit
    ? match[1] !== undefined
      ? parseInt(match[1], 10)
      : null
    : INTERRUPTED_TAIL_RE.test(stripped)
      ? 130
      : null;

  return { exitCode, stripped, source: useExit ? "exit" : "prompt" };
}

export interface TerminalMarkerTrackerOptions {
  getBuffer(): string;
  setBuffer(buffer: string): void;
  isActive(): boolean;
  onMarker(marker: ShellCompletionMarker, source: "stream" | "poll"): void;
  pollIntervalMs?: number;
}

export interface TerminalMarkerTracker extends TerminalCompletionDisposable {
  check(source?: "stream" | "poll"): boolean;
}

export function createTerminalMarkerTracker(
  options: TerminalMarkerTrackerOptions,
): TerminalMarkerTracker {
  let disposed = false;
  let lastCheckPosition = 0;

  const check = (source: "stream" | "poll" = "stream"): boolean => {
    if (disposed) return false;
    const buffer = options.getBuffer();
    const marker = findAndStripTerminalMarker(buffer, lastCheckPosition);
    if (marker) {
      options.setBuffer(marker.stripped);
      options.onMarker(marker, source);
      return true;
    }
    lastCheckPosition = buffer.length;
    return false;
  };

  const interval = setInterval(() => {
    if (!options.isActive()) {
      dispose();
      return;
    }
    if (options.getBuffer().length > lastCheckPosition) {
      check("poll");
    }
  }, options.pollIntervalMs ?? MARKER_POLL_MS);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(interval);
  };

  return { check, dispose };
}
