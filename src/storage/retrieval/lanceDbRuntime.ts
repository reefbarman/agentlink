import { createRequire } from "node:module";
import { spawn } from "node:child_process";

type LanceDbModule = typeof import("@lancedb/lancedb");

/**
 * LanceDB ships a ~250 MB native addon. On macOS the first load of a freshly
 * installed copy is held for seconds by the system's code security check, and
 * a top-level import would do that synchronously while the host module loads.
 * Everything that needs LanceDB goes through this module instead, so the addon
 * loads on first use and can be warmed in a separate process beforehand.
 */
let lanceDbPromise: Promise<LanceDbModule> | undefined;
let lanceDb: LanceDbModule | undefined;
let warmUp: Promise<void> | undefined;

const MAX_WARM_UP_WAIT_MS = 15_000;

export interface LanceDbWarmUpOptions {
  /** Directory whose node_modules contains `@lancedb/lancedb`. */
  readonly moduleDirectory: string;
  /** Defaults to `process.execPath`. */
  readonly nodeExecutable?: string;
  readonly log?: (message: string) => void;
}

/**
 * Load the native addon once in a short-lived child process so the operating
 * system's first-load check happens off this thread. The later in-process load
 * then takes the fast path. Never rejects; LanceDB still loads without it.
 */
export function prewarmLanceDbNativeModule(
  options: LanceDbWarmUpOptions,
): Promise<void> {
  if (warmUp || lanceDb) return warmUp ?? Promise.resolve();
  const startedAt = Date.now();
  warmUp = new Promise<void>((resolve) => {
    let settled = false;
    const finish = (outcome: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.log?.(
        `[lancedb] native warm-up ${outcome} in ${Date.now() - startedAt}ms`,
      );
      resolve();
    };
    const timer = setTimeout(() => {
      child?.kill();
      finish("timed out");
    }, MAX_WARM_UP_WAIT_MS);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(
        options.nodeExecutable ?? process.execPath,
        [
          "-e",
          'require(require.resolve("@lancedb/lancedb", { paths: [process.argv[1]] }))',
          options.moduleDirectory,
        ],
        {
          env: {
            ...process.env,
            ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
          },
          stdio: "ignore",
          windowsHide: true,
        },
      );
    } catch (error) {
      finish(`failed to start (${String(error)})`);
      return;
    }
    child.once("error", (error) => finish(`failed (${String(error)})`));
    child.once("exit", (code, signal) =>
      finish(
        code === 0 ? "completed" : `exited (code=${code}, signal=${signal})`,
      ),
    );
  });
  return warmUp;
}

export function loadLanceDb(): Promise<LanceDbModule> {
  if (lanceDbPromise) return lanceDbPromise;
  const pending = (async () => {
    if (warmUp) await warmUp;
    // CommonJS bundles keep ordinary require resolution (bundle-adjacent
    // node_modules and NODE_PATH); ESM consumers fall back to import().
    const loaded: LanceDbModule =
      typeof __filename === "string"
        ? (createRequire(__filename)("@lancedb/lancedb") as LanceDbModule)
        : await import("@lancedb/lancedb");
    lanceDb = loaded;
    return loaded;
  })();
  lanceDbPromise = pending;
  // Let a later call retry if the addon failed to load.
  pending.catch(() => {
    if (lanceDbPromise === pending) lanceDbPromise = undefined;
  });
  return pending;
}

function requireLoadedLanceDb(): LanceDbModule {
  if (!lanceDb) {
    throw new Error(
      "LanceDB is used before a connection was opened; call connect() first.",
    );
  }
  return lanceDb;
}

export const connect = (async (...args: unknown[]) => {
  const loaded = await loadLanceDb();
  return (loaded.connect as (...connectArgs: unknown[]) => unknown)(...args);
}) as LanceDbModule["connect"];

/** Sync helpers are only reachable once a connection has loaded the addon. */
export const makeArrowTable = ((...args: unknown[]) =>
  (
    requireLoadedLanceDb().makeArrowTable as (
      ...tableArgs: unknown[]
    ) => unknown
  )(...args)) as LanceDbModule["makeArrowTable"];

export const Index = {
  fts: ((...args: unknown[]) =>
    (requireLoadedLanceDb().Index.fts as (...indexArgs: unknown[]) => unknown)(
      ...args,
    )) as LanceDbModule["Index"]["fts"],
  btree: ((...args: unknown[]) =>
    (
      requireLoadedLanceDb().Index.btree as (...indexArgs: unknown[]) => unknown
    )(...args)) as LanceDbModule["Index"]["btree"],
};
