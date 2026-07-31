/**
 * Native-thread budget for the indexer worker process.
 *
 * The worker embeds LanceDB, whose Rust runtime sizes its tokio, rayon, and
 * compute thread pools to every logical core by default. Compaction and
 * optimize passes on large stores then burn all cores simultaneously
 * (observed: an 18-core machine held at ~650% CPU for over an hour while the
 * fans ran flat out). `os.setPriority(19)` inside the worker keeps it from
 * starving interactive work but does not reduce the thermal load, so the fork
 * environment clamps the pools to a fraction of the machine instead. Any of
 * these variables already present in the parent environment win, so power
 * users can still override the budget per machine.
 */

export interface IndexerWorkerResourceEnv {
  LANCE_CPU_THREADS: string;
  RAYON_NUM_THREADS: string;
  TOKIO_WORKER_THREADS: string;
  LANCE_IO_THREADS: string;
}

const MIN_COMPUTE_THREADS = 2;
const MAX_COMPUTE_THREADS = 6;
const MIN_RUNTIME_THREADS = 4;
const MAX_IO_THREADS = 8;

export function indexerWorkerResourceEnv(
  logicalCores: number,
  baseEnv: NodeJS.ProcessEnv,
): IndexerWorkerResourceEnv {
  const cores =
    Number.isFinite(logicalCores) && logicalCores >= 1
      ? Math.floor(logicalCores)
      : MIN_RUNTIME_THREADS;
  const compute = Math.min(
    MAX_COMPUTE_THREADS,
    Math.max(MIN_COMPUTE_THREADS, Math.floor(cores / 4)),
  );
  const runtime = Math.max(MIN_RUNTIME_THREADS, compute);
  const io = Math.min(
    MAX_IO_THREADS,
    Math.max(MIN_RUNTIME_THREADS, Math.floor(cores / 2)),
  );
  return {
    LANCE_CPU_THREADS: baseEnv.LANCE_CPU_THREADS ?? String(compute),
    RAYON_NUM_THREADS: baseEnv.RAYON_NUM_THREADS ?? String(compute),
    TOKIO_WORKER_THREADS: baseEnv.TOKIO_WORKER_THREADS ?? String(runtime),
    LANCE_IO_THREADS: baseEnv.LANCE_IO_THREADS ?? String(io),
  };
}
