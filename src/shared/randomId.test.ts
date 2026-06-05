import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "./randomId";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("randomId", () => {
  it("uses crypto.randomUUID when available (secure context)", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
      getRandomValues: (a: Uint8Array) => a,
    });
    expect(randomId()).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("falls back to getRandomValues when randomUUID is missing (insecure context)", () => {
    // Simulate an insecure context: randomUUID is not exposed.
    vi.stubGlobal("crypto", {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = (i * 17 + 3) & 0xff;
        return arr;
      },
    });
    const id = randomId();
    expect(id).toMatch(UUID_RE);
  });

  it("degrades gracefully when Web Crypto is entirely absent", () => {
    vi.stubGlobal("crypto", undefined);
    const id = randomId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("produces distinct ids across calls in insecure context", () => {
    let seed = 0;
    vi.stubGlobal("crypto", {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = (seed++ * 31) & 0xff;
        return arr;
      },
    });
    expect(randomId()).not.toBe(randomId());
  });
});
