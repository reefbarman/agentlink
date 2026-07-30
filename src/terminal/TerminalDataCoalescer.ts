import { Buffer } from "node:buffer";

/**
 * Coalesces bursts of PTY output per terminal before they are parsed and
 * shipped to the renderer, mirroring VS Code's pty-host `TerminalDataBufferer`.
 *
 * node-pty delivers sustained output as a stream of small chunks. Turning each
 * chunk into its own render batch multiplies every fixed cost on the path —
 * shell-integration parsing, block-state reduction, webview `postMessage`,
 * xterm write-callback waits, and acknowledgment messages — which is what made
 * heavy output render slowly. Buffering for a few milliseconds converts that
 * stream into a small number of large writes without changing ordering.
 */
export interface TerminalDataCoalescerOptions {
  onFlush(terminalId: string, data: string): void;
  /**
   * Milliseconds to wait for more output before flushing. `0` disables
   * coalescing entirely and delivers every push synchronously; tests use this
   * to keep event ordering deterministic.
   */
  flushDelayMs?: number;
  /** Buffered bytes that force an immediate flush ahead of the timer, bounding
   * memory and the size of a single render batch. */
  maxBufferedBytes?: number;
  schedule?(callback: () => void, delayMs: number): unknown;
  cancel?(handle: unknown): void;
}

const DEFAULT_FLUSH_DELAY_MS = 5;
const DEFAULT_MAX_BUFFERED_BYTES = 128 * 1024;

interface PendingTerminalData {
  chunks: string[];
  byteLength: number;
  timer: unknown;
}

export class TerminalDataCoalescer {
  private readonly onFlush: (terminalId: string, data: string) => void;
  private readonly flushDelayMs: number;
  private readonly maxBufferedBytes: number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly pending = new Map<string, PendingTerminalData>();
  private disposed = false;

  constructor(options: TerminalDataCoalescerOptions) {
    const flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    const maxBufferedBytes =
      options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    if (!Number.isSafeInteger(flushDelayMs) || flushDelayMs < 0) {
      throw new Error("flushDelayMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
      throw new Error("maxBufferedBytes must be a positive safe integer");
    }
    this.onFlush = options.onFlush;
    this.flushDelayMs = flushDelayMs;
    this.maxBufferedBytes = maxBufferedBytes;
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel =
      options.cancel ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  push(terminalId: string, data: string): void {
    if (this.disposed || !data) return;
    if (this.flushDelayMs === 0) {
      this.onFlush(terminalId, data);
      return;
    }
    let entry = this.pending.get(terminalId);
    if (!entry) {
      entry = { chunks: [], byteLength: 0, timer: undefined };
      this.pending.set(terminalId, entry);
    }
    entry.chunks.push(data);
    entry.byteLength += Buffer.byteLength(data, "utf8");
    if (entry.byteLength >= this.maxBufferedBytes) {
      this.flush(terminalId);
      return;
    }
    if (entry.timer === undefined) {
      entry.timer = this.schedule(
        () => this.flush(terminalId),
        this.flushDelayMs,
      );
    }
  }

  /** Delivers any buffered output for the terminal synchronously, preserving
   * order with whatever the caller processes next (exit, replay snapshot). */
  flush(terminalId: string): void {
    const entry = this.take(terminalId);
    if (!entry || this.disposed) return;
    this.onFlush(terminalId, entry.chunks.join(""));
  }

  flushAll(): void {
    // Snapshot the keys: a flush handler may push again re-entrantly.
    const terminalIds = Array.from(this.pending.keys());
    for (const terminalId of terminalIds) {
      this.flush(terminalId);
    }
  }

  /** Drops buffered output without delivering it, for terminals that no longer
   * exist. */
  discard(terminalId: string): void {
    this.take(terminalId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) this.cancel(entry.timer);
    }
    this.pending.clear();
  }

  private take(terminalId: string): PendingTerminalData | undefined {
    const entry = this.pending.get(terminalId);
    if (!entry) return undefined;
    this.pending.delete(terminalId);
    if (entry.timer !== undefined) this.cancel(entry.timer);
    return entry;
  }
}
