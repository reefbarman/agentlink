import { afterEach } from "vitest";
import { options } from "preact";

// Preact 11 runs useEffect callbacks and unmount cleanups after the next paint.
// @testing-library/preact unmounts without act(), so those cleanups can outlive
// the test that queued them and even its jsdom environment. Track each queued
// after-paint flush and drain whatever is still pending once a test finishes.
// act() swaps in its own scheduler while it runs and restores this one after.
const pendingFlushes = new Set<() => void>();

options.requestAnimationFrame = (flush) => {
  pendingFlushes.add(flush);
  setTimeout(() => {
    if (pendingFlushes.delete(flush)) flush();
  });
};

afterEach(() => {
  for (const flush of pendingFlushes) {
    pendingFlushes.delete(flush);
    flush();
  }
});
