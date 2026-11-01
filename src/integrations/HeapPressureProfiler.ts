import * as fs from "node:fs";
import * as inspector from "node:inspector";
import * as path from "node:path";
import * as v8 from "node:v8";

/**
 * Opt-in diagnostic for extension-host heap exhaustion. Starts V8's sampling
 * heap profiler and writes the live allocation profile each time heap use
 * first crosses a fraction of the heap limit, so an out-of-memory crash leaves
 * evidence of which functions hold the memory. The profile loads in Chrome
 * DevTools (Memory tab) as a `.heapprofile`; a short top-allocators summary is
 * written next to it.
 *
 * Polling cannot observe a single synchronous allocation burst, so the earlier
 * thresholds exist to capture growth before the final one.
 */

export const HEAP_PRESSURE_DEFAULT_FRACTIONS = [0.35, 0.6, 0.85] as const;
const DEFAULT_INTERVAL_MS = 500;
/** Bytes between samples; V8's default (512 KiB) halved for finer attribution. */
const SAMPLING_INTERVAL_BYTES = 256 * 1024;
const SUMMARY_TOP_FUNCTIONS = 25;

interface SamplingNode {
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  selfSize: number;
  children?: SamplingNode[];
}

export interface HeapPressureProfilerSession {
  connect(): void;
  post(method: string, params?: object): Promise<unknown>;
  disconnect(): void;
}

export interface HeapPressureProfilerOptions {
  directory: string;
  log: (message: string) => void;
  fractions?: readonly number[];
  intervalMs?: number;
  /** Test seams. */
  getHeapStatistics?: () => { used_heap_size: number; heap_size_limit: number };
  createSession?: () => HeapPressureProfilerSession;
  now?: () => Date;
  pid?: number;
}

export interface HeapPressureCapture {
  threshold: number;
  usedBytes: number;
  limitBytes: number;
  profilePath: string;
  summaryPath: string;
}

function defaultSession(): HeapPressureProfilerSession {
  const session = new inspector.Session();
  return {
    connect: () => session.connect(),
    disconnect: () => session.disconnect(),
    post: (method, params) =>
      new Promise((resolve, reject) => {
        session.post(method, params ?? {}, (error, result) =>
          error ? reject(error) : resolve(result),
        );
      }),
  };
}

const mib = (bytes: number) => `${(bytes / 1048576).toFixed(0)} MiB`;

/** Aggregate sampled self sizes by function and source position. */
export function summarizeSamplingProfile(
  head: SamplingNode,
  top = SUMMARY_TOP_FUNCTIONS,
): Array<{ frame: string; selfBytes: number }> {
  const totals = new Map<string, number>();
  const stack: SamplingNode[] = [head];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.selfSize > 0) {
      const { functionName, url, lineNumber, columnNumber } = node.callFrame;
      const frame = `${functionName || "(anonymous)"} ${url || "(native)"}:${lineNumber + 1}:${columnNumber + 1}`;
      totals.set(frame, (totals.get(frame) ?? 0) + node.selfSize);
    }
    if (node.children) stack.push(...node.children);
  }
  return [...totals.entries()]
    .map(([frame, selfBytes]) => ({ frame, selfBytes }))
    .sort((left, right) => right.selfBytes - left.selfBytes)
    .slice(0, top);
}

export class HeapPressureProfiler {
  private session: HeapPressureProfilerSession | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private nextThresholdIndex = 0;
  private capturing = false;
  private readonly fractions: number[];
  private readonly getHeapStatistics: NonNullable<
    HeapPressureProfilerOptions["getHeapStatistics"]
  >;

  constructor(private readonly options: HeapPressureProfilerOptions) {
    this.fractions = [
      ...(options.fractions ?? HEAP_PRESSURE_DEFAULT_FRACTIONS),
    ].sort((left, right) => left - right);
    this.getHeapStatistics =
      options.getHeapStatistics ?? (() => v8.getHeapStatistics());
  }

  async start(): Promise<void> {
    if (this.session) return;
    const session = (this.options.createSession ?? defaultSession)();
    session.connect();
    await session.post("HeapProfiler.enable");
    await session.post("HeapProfiler.startSampling", {
      samplingInterval: SAMPLING_INTERVAL_BYTES,
    });
    this.session = session;
    const { heap_size_limit } = this.getHeapStatistics();
    this.options.log(
      `[heap-profiler] sampling started; captures at ${this.fractions
        .map((fraction) => mib(heap_size_limit * fraction))
        .join(", ")} of ${mib(heap_size_limit)} into ${this.options.directory}`,
    );
    this.timer = setInterval(
      () => void this.check(),
      this.options.intervalMs ?? DEFAULT_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  /** Capture once per newly crossed threshold. Exposed for tests. */
  async check(): Promise<HeapPressureCapture | undefined> {
    if (!this.session || this.capturing) return undefined;
    const fraction = this.fractions[this.nextThresholdIndex];
    if (fraction === undefined) return undefined;
    const { used_heap_size, heap_size_limit } = this.getHeapStatistics();
    if (used_heap_size < heap_size_limit * fraction) return undefined;
    // Skip any further thresholds already crossed; one capture per check.
    while (
      this.fractions[this.nextThresholdIndex] !== undefined &&
      used_heap_size >=
        heap_size_limit * this.fractions[this.nextThresholdIndex]!
    ) {
      this.nextThresholdIndex += 1;
    }
    this.capturing = true;
    try {
      return await this.capture(fraction, used_heap_size, heap_size_limit);
    } catch (error) {
      this.options.log(
        `[heap-profiler] capture failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    } finally {
      this.capturing = false;
    }
  }

  private async capture(
    threshold: number,
    usedBytes: number,
    limitBytes: number,
  ): Promise<HeapPressureCapture> {
    const result = (await this.session!.post(
      "HeapProfiler.getSamplingProfile",
    )) as { profile: { head: SamplingNode } };
    const stamp = (this.options.now?.() ?? new Date())
      .toISOString()
      .replace(/[:.]/g, "-");
    const base = `heap-${this.options.pid ?? process.pid}-${stamp}-${Math.round(threshold * 100)}pct`;
    await fs.promises.mkdir(this.options.directory, { recursive: true });
    const profilePath = path.join(
      this.options.directory,
      `${base}.heapprofile`,
    );
    const summaryPath = path.join(this.options.directory, `${base}.txt`);
    await fs.promises.writeFile(profilePath, JSON.stringify(result.profile));
    const top = summarizeSamplingProfile(result.profile.head);
    const summary = [
      `heap used ${mib(usedBytes)} of ${mib(limitBytes)} (threshold ${Math.round(threshold * 100)}%)`,
      "Top sampled allocations still live (self size):",
      ...top.map(
        (entry) => `${mib(entry.selfBytes).padStart(9)}  ${entry.frame}`,
      ),
    ].join("\n");
    await fs.promises.writeFile(summaryPath, `${summary}\n`);
    this.options.log(
      `[heap-profiler] heap ${mib(usedBytes)}/${mib(limitBytes)}; wrote ${profilePath}\n${summary}`,
    );
    return { threshold, usedBytes, limitBytes, profilePath, summaryPath };
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const session = this.session;
    this.session = undefined;
    if (!session) return;
    void session
      .post("HeapProfiler.stopSampling")
      .catch(() => undefined)
      .finally(() => session.disconnect());
  }
}
