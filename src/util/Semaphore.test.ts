import { describe, expect, it } from "vitest";

import { Semaphore } from "./Semaphore.js";

describe("Semaphore", () => {
  it("limits concurrent holders and admits waiters in FIFO order", async () => {
    const semaphore = new Semaphore(2);
    const firstRelease = await semaphore.acquire();
    const secondRelease = await semaphore.acquire();
    const admitted: string[] = [];

    const third = semaphore.acquire().then((release) => {
      admitted.push("third");
      return release;
    });
    const fourth = semaphore.acquire().then((release) => {
      admitted.push("fourth");
      return release;
    });

    expect(semaphore.waiting).toBe(2);
    expect(admitted).toEqual([]);

    firstRelease();
    const thirdRelease = await third;
    expect(admitted).toEqual(["third"]);
    expect(semaphore.waiting).toBe(1);

    secondRelease();
    const fourthRelease = await fourth;
    expect(admitted).toEqual(["third", "fourth"]);
    expect(semaphore.waiting).toBe(0);

    thirdRelease();
    fourthRelease();
  });

  it("can release a permit in finally after guarded work rejects", async () => {
    const semaphore = new Semaphore(1);

    const failingWork = async (): Promise<void> => {
      const release = await semaphore.acquire();
      try {
        throw new Error("boom");
      } finally {
        release();
      }
    };

    await expect(failingWork()).rejects.toThrow("boom");

    const release = await semaphore.acquire();
    expect(semaphore.waiting).toBe(0);
    release();
  });
});
