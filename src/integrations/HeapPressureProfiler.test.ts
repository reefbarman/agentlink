import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HeapPressureProfiler,
  summarizeSamplingProfile,
  type HeapPressureProfilerSession,
} from "./HeapPressureProfiler.js";

const GiB = 1024 ** 3;

function frame(functionName: string, url: string, lineNumber: number) {
  return { functionName, url, lineNumber, columnNumber: 0 };
}

const profile = {
  head: {
    callFrame: frame("(root)", "", 0),
    selfSize: 0,
    children: [
      { callFrame: frame("readSession", "store.js", 9), selfSize: 300 },
      {
        callFrame: frame("outer", "a.js", 0),
        selfSize: 10,
        children: [
          { callFrame: frame("readSession", "store.js", 9), selfSize: 200 },
          { callFrame: frame("", "b.js", 4), selfSize: 50 },
        ],
      },
    ],
  },
};

describe("HeapPressureProfiler", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aggregates sampled self sizes by frame, largest first", () => {
    expect(summarizeSamplingProfile(profile.head)).toEqual([
      { frame: "readSession store.js:10:1", selfBytes: 500 },
      { frame: "(anonymous) b.js:5:1", selfBytes: 50 },
      { frame: "outer a.js:1:1", selfBytes: 10 },
    ]);
  });

  it("captures once per crossed threshold and writes profile and summary", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "heap-profiler-"));
    dirs.push(directory);
    const posted: string[] = [];
    const session: HeapPressureProfilerSession = {
      connect: () => undefined,
      disconnect: () => undefined,
      post: async (method) => {
        posted.push(method);
        return method === "HeapProfiler.getSamplingProfile" ? { profile } : {};
      },
    };
    let used = 0.1 * GiB;
    const logs: string[] = [];
    const profiler = new HeapPressureProfiler({
      directory,
      log: (message) => logs.push(message),
      fractions: [0.35, 0.6, 0.85],
      intervalMs: 60_000,
      getHeapStatistics: () => ({
        used_heap_size: used,
        heap_size_limit: 4 * GiB,
      }),
      createSession: () => session,
      now: () => new Date("2026-11-01T08:52:30.000Z"),
      pid: 42,
    });
    await profiler.start();
    expect(posted).toEqual([
      "HeapProfiler.enable",
      "HeapProfiler.startSampling",
    ]);

    expect(await profiler.check()).toBeUndefined();

    // Jumping past two thresholds produces one capture labelled with the first.
    used = 2.5 * GiB;
    const capture = await profiler.check();
    expect(capture?.threshold).toBe(0.35);
    expect(path.basename(capture!.profilePath)).toBe(
      "heap-42-2026-11-01T08-52-30-000Z-35pct.heapprofile",
    );
    expect(JSON.parse(fs.readFileSync(capture!.profilePath, "utf8"))).toEqual(
      profile,
    );
    expect(fs.readFileSync(capture!.summaryPath, "utf8")).toContain(
      "readSession store.js:10:1",
    );
    expect(await profiler.check()).toBeUndefined();

    used = 3.5 * GiB;
    expect((await profiler.check())?.threshold).toBe(0.85);
    expect(await profiler.check()).toBeUndefined();
    profiler.dispose();
  });

  it("captures a real sampling profile through node:inspector", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "heap-profiler-"));
    dirs.push(directory);
    const profiler = new HeapPressureProfiler({
      directory,
      log: () => undefined,
      fractions: [0],
      intervalMs: 60_000,
    });
    await profiler.start();
    const retained = Array.from({ length: 2_000 }, (_, i) => "x".repeat(i));
    const capture = await profiler.check();
    profiler.dispose();
    expect(retained.length).toBe(2_000);
    const written = JSON.parse(fs.readFileSync(capture!.profilePath, "utf8"));
    expect(written.head.callFrame).toBeDefined();
    expect(fs.readFileSync(capture!.summaryPath, "utf8")).toMatch(/heap used/);
  });
});
