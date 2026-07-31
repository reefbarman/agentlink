import { describe, expect, it } from "vitest";

import { indexerWorkerResourceEnv } from "./workerResourceLimits.js";

describe("indexerWorkerResourceEnv", () => {
  it("clamps compute pools to a quarter of the machine on large hosts", () => {
    const env = indexerWorkerResourceEnv(18, {});
    expect(env).toEqual({
      LANCE_CPU_THREADS: "4",
      RAYON_NUM_THREADS: "4",
      TOKIO_WORKER_THREADS: "4",
      LANCE_IO_THREADS: "8",
    });
  });

  it("never drops below the minimum pool sizes on small hosts", () => {
    const env = indexerWorkerResourceEnv(4, {});
    expect(env).toEqual({
      LANCE_CPU_THREADS: "2",
      RAYON_NUM_THREADS: "2",
      TOKIO_WORKER_THREADS: "4",
      LANCE_IO_THREADS: "4",
    });
  });

  it("caps compute and io pools on very large hosts", () => {
    const env = indexerWorkerResourceEnv(64, {});
    expect(env.LANCE_CPU_THREADS).toBe("6");
    expect(env.RAYON_NUM_THREADS).toBe("6");
    expect(env.TOKIO_WORKER_THREADS).toBe("6");
    expect(env.LANCE_IO_THREADS).toBe("8");
  });

  it("preserves explicit overrides from the parent environment", () => {
    const env = indexerWorkerResourceEnv(18, {
      LANCE_CPU_THREADS: "12",
      TOKIO_WORKER_THREADS: "16",
    });
    expect(env.LANCE_CPU_THREADS).toBe("12");
    expect(env.TOKIO_WORKER_THREADS).toBe("16");
    expect(env.RAYON_NUM_THREADS).toBe("4");
    expect(env.LANCE_IO_THREADS).toBe("8");
  });

  it("falls back to safe defaults when the core count is unusable", () => {
    for (const cores of [0, -1, Number.NaN]) {
      const env = indexerWorkerResourceEnv(cores, {});
      expect(env.LANCE_CPU_THREADS).toBe("2");
      expect(env.TOKIO_WORKER_THREADS).toBe("4");
      expect(env.LANCE_IO_THREADS).toBe("4");
    }
  });
});
