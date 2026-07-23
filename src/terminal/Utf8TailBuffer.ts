import { Buffer } from "node:buffer";

/**
 * Byte-capped UTF-8 tail accumulator for terminal output.
 *
 * Appends are O(appended chunk): each chunk is encoded once and pushed onto a
 * buffer list, and trimming drops whole leading chunks (plus an O(1) subarray
 * view for a partial head trim). The retained tail is only decoded back into a
 * string on read, with the result cached until the next append. This replaces
 * the previous retain-a-string approach, which re-encoded and copied the whole
 * retained tail (up to the cap) on every appended chunk — quadratic in total
 * output volume and heavy enough to starve the extension-host event loop
 * while a command streamed output.
 */
export class Utf8TailBuffer {
  private readonly maxBytes: number;
  private chunks: Buffer[] = [];
  private retainedBytes = 0;
  private dropped = 0;
  private cached: string | undefined = "";
  // A surrogate pair split across appended chunks must be encoded together to
  // produce the original character rather than two replacement characters.
  private pendingHighSurrogate = "";

  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("maxBytes must be a positive safe integer");
    }
    this.maxBytes = maxBytes;
  }

  /** Retained tail size in UTF-8 bytes (excludes an incomplete trailing surrogate). */
  get byteLength(): number {
    return this.retainedBytes;
  }

  /** Cumulative bytes trimmed from the front of the tail. */
  get droppedBytes(): number {
    return this.dropped;
  }

  get isEmpty(): boolean {
    return (
      this.retainedBytes === 0 &&
      this.dropped === 0 &&
      this.pendingHighSurrogate === ""
    );
  }

  append(text: string): void {
    if (this.pendingHighSurrogate) {
      text = this.pendingHighSurrogate + text;
      this.pendingHighSurrogate = "";
    }
    if (text.length === 0) return;
    const lastCode = text.charCodeAt(text.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      this.pendingHighSurrogate = text.slice(-1);
      text = text.slice(0, -1);
      if (text.length === 0) return;
    }
    const chunk = Buffer.from(text, "utf8");
    this.chunks.push(chunk);
    this.retainedBytes += chunk.byteLength;
    this.cached = undefined;
    this.trim();
  }

  toString(): string {
    if (this.cached === undefined) {
      // Compact into a single buffer so the chunk list stays bounded and
      // repeated reads after further appends stay cheap.
      const compacted = Buffer.concat(this.chunks);
      this.chunks = compacted.byteLength > 0 ? [compacted] : [];
      this.cached = compacted.toString("utf8");
    }
    return this.cached;
  }

  private trim(): void {
    let excess = this.retainedBytes - this.maxBytes;
    if (excess <= 0) return;
    while (excess > 0 && this.chunks.length > 0) {
      const head = this.chunks[0];
      if (head.byteLength <= excess) {
        this.chunks.shift();
        excess -= head.byteLength;
        this.retainedBytes -= head.byteLength;
        this.dropped += head.byteLength;
        continue;
      }
      // Partial head trim: advance past UTF-8 continuation bytes so the tail
      // starts on a character boundary. Chunks are individually valid UTF-8,
      // so a whole-chunk drop already lands on a boundary.
      let start = excess;
      while (start < head.byteLength && (head[start] & 0xc0) === 0x80) {
        start += 1;
      }
      this.chunks[0] = head.subarray(start);
      this.retainedBytes -= start;
      this.dropped += start;
      excess = 0;
    }
  }
}
