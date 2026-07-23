import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { Utf8TailBuffer } from "./Utf8TailBuffer.js";

describe("Utf8TailBuffer", () => {
  it("rejects a non-positive or unsafe cap", () => {
    expect(() => new Utf8TailBuffer(0)).toThrow(/positive safe integer/);
    expect(() => new Utf8TailBuffer(-1)).toThrow(/positive safe integer/);
    expect(() => new Utf8TailBuffer(1.5)).toThrow(/positive safe integer/);
  });

  it("starts empty", () => {
    const tail = new Utf8TailBuffer(16);
    expect(tail.isEmpty).toBe(true);
    expect(tail.toString()).toBe("");
    expect(tail.byteLength).toBe(0);
    expect(tail.droppedBytes).toBe(0);
  });

  it("accumulates appends below the cap without dropping", () => {
    const tail = new Utf8TailBuffer(32);
    tail.append("hello ");
    tail.append("world");
    expect(tail.toString()).toBe("hello world");
    expect(tail.byteLength).toBe(11);
    expect(tail.droppedBytes).toBe(0);
    expect(tail.isEmpty).toBe(false);
  });

  it("retains only the byte-capped tail across many appends", () => {
    const tail = new Utf8TailBuffer(8);
    tail.append("abcdefgh");
    tail.append("ijkl");
    expect(tail.toString()).toBe("efghijkl");
    expect(tail.byteLength).toBe(8);
    expect(tail.droppedBytes).toBe(4);
  });

  it("drops a whole chunk larger than the cap down to its tail", () => {
    const tail = new Utf8TailBuffer(4);
    tail.append("0123456789");
    expect(tail.toString()).toBe("6789");
    expect(tail.byteLength).toBe(4);
    expect(tail.droppedBytes).toBe(6);
  });

  it("trims forward to a UTF-8 character boundary", () => {
    const tail = new Utf8TailBuffer(3);
    // "é" is 2 bytes; cutting mid-character must not produce a mangled char.
    tail.append("aéé"); // bytes: a(1) é(2) é(2) = 5 → trim 2 lands mid-first-é
    expect(tail.toString()).toBe("é");
    expect(tail.byteLength).toBe(2);
    expect(tail.droppedBytes).toBe(3);
  });

  it("keeps totals consistent: retained + dropped = appended bytes (boundary drift aside)", () => {
    const tail = new Utf8TailBuffer(1000);
    let appended = 0;
    for (let i = 0; i < 500; i++) {
      const chunk = `line ${i} ${"x".repeat(i % 37)}\n`;
      appended += Buffer.byteLength(chunk, "utf8");
      tail.append(chunk);
    }
    expect(tail.byteLength).toBeLessThanOrEqual(1000);
    expect(tail.byteLength + tail.droppedBytes).toBe(appended);
    expect(Buffer.byteLength(tail.toString(), "utf8")).toBe(tail.byteLength);
  });

  it("matches a reference string-tail implementation on multi-byte content", () => {
    const cap = 64;
    const tail = new Utf8TailBuffer(cap);
    let reference = "";
    const chunks = [
      "héllo wörld ",
      "日本語テキスト",
      "🙂🙃",
      "plain ascii tail ",
      "末尾",
    ];
    for (let i = 0; i < 20; i++) {
      const chunk = chunks[i % chunks.length];
      tail.append(chunk);
      reference += chunk;
    }
    const referenceBytes = Buffer.from(reference, "utf8");
    let start = Math.max(0, referenceBytes.byteLength - cap);
    while (
      start < referenceBytes.byteLength &&
      (referenceBytes[start] & 0xc0) === 0x80
    ) {
      start += 1;
    }
    expect(tail.toString()).toBe(
      referenceBytes.subarray(start).toString("utf8"),
    );
  });

  it("recombines a surrogate pair split across appends", () => {
    const emoji = "🙂";
    const tail = new Utf8TailBuffer(64);
    tail.append(`a${emoji[0]}`);
    tail.append(`${emoji[1]}b`);
    expect(tail.toString()).toBe("a🙂b");
    expect(tail.byteLength).toBe(Buffer.byteLength("a🙂b", "utf8"));
  });

  it("does not count or emit an incomplete trailing high surrogate", () => {
    const tail = new Utf8TailBuffer(64);
    tail.append("ab");
    tail.append("🙂"[0]);
    expect(tail.toString()).toBe("ab");
    expect(tail.byteLength).toBe(2);
    expect(tail.isEmpty).toBe(false);
  });

  it("returns a stable cached string until the next append", () => {
    const tail = new Utf8TailBuffer(16);
    tail.append("abc");
    const first = tail.toString();
    expect(tail.toString()).toBe(first);
    tail.append("def");
    expect(tail.toString()).toBe("abcdef");
  });

  it("handles empty appends without state changes", () => {
    const tail = new Utf8TailBuffer(8);
    tail.append("");
    expect(tail.isEmpty).toBe(true);
    tail.append("data");
    tail.append("");
    expect(tail.toString()).toBe("data");
  });
});
