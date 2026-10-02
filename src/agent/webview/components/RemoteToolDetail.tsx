import { useContext, useEffect, useRef, useState } from "preact/hooks";

import type { ContentBlock } from "@agentlink/protocol/chat-transcript";
import { createContext } from "preact";

type RemoteToolBlock = Extract<
  ContentBlock,
  { type: "tool_call" | "skill_load" }
>;

interface RemoteToolDetailContextValue {
  load: (
    block: RemoteToolBlock,
    wanted: () => boolean,
  ) => Promise<RemoteToolBlock>;
}

const RemoteToolDetailContext =
  createContext<RemoteToolDetailContextValue | null>(null);

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CONCURRENT_LOADS = 2;

interface CacheEntry {
  block: RemoteToolBlock;
  bytes: number;
}

interface QueuedLoad<T> {
  wanted: Array<() => boolean>;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function byteSize(block: RemoteToolBlock): number {
  const json = JSON.stringify(block);
  return typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(json).byteLength
    : json.length * 2;
}

function detailKey(block: RemoteToolBlock): string {
  const detail = block.remoteDetail;
  return `${block.type}:${block.id}:${detail?.messageId ?? ""}:${detail?.contentRevision ?? 0}`;
}

export function RemoteToolDetailProvider(props: {
  scopeKey: string;
  loadDetail: (block: RemoteToolBlock) => Promise<RemoteToolBlock>;
  children: preact.ComponentChildren;
}) {
  return (
    <RemoteToolDetailScopeProvider
      key={props.scopeKey}
      loadDetail={props.loadDetail}
    >
      {props.children}
    </RemoteToolDetailScopeProvider>
  );
}

function RemoteToolDetailScopeProvider({
  loadDetail,
  children,
}: {
  loadDetail: (block: RemoteToolBlock) => Promise<RemoteToolBlock>;
  children: preact.ComponentChildren;
}) {
  const cache = useRef(new Map<string, CacheEntry>());
  const pending = useRef(
    new Map<
      string,
      {
        promise: Promise<RemoteToolBlock>;
        wanted: Array<() => boolean>;
      }
    >(),
  );
  const queue = useRef<QueuedLoad<RemoteToolBlock>[]>([]);
  const activeLoads = useRef(0);
  const cacheBytes = useRef(0);
  const loader = useRef(loadDetail);
  loader.current = loadDetail;

  const runQueue = () => {
    while (activeLoads.current < MAX_CONCURRENT_LOADS && queue.current.length) {
      const item = queue.current.shift()!;
      if (!item.wanted.some((wanted) => wanted())) {
        item.reject(new Error("Tool detail request superseded"));
        continue;
      }
      activeLoads.current += 1;
      item
        .run()
        .then(item.resolve, item.reject)
        .finally(() => {
          activeLoads.current -= 1;
          runQueue();
        });
    }
  };

  const load = (block: RemoteToolBlock, isWanted: () => boolean) => {
    const key = detailKey(block);
    const cached = cache.current.get(key);
    if (cached) {
      cache.current.delete(key);
      cache.current.set(key, cached);
      return Promise.resolve(cached.block);
    }
    const existing = pending.current.get(key);
    if (existing) {
      existing.wanted.push(isWanted);
      return existing.promise;
    }
    const wanted = [isWanted];

    const promise = new Promise<RemoteToolBlock>((resolve, reject) => {
      queue.current.push({
        wanted,
        run: () => loader.current(block),
        resolve,
        reject,
      });
      runQueue();
    })
      .then((loaded) => {
        if (loaded.type !== block.type || loaded.id !== block.id) {
          throw new Error(
            "Remote tool detail did not match the requested block",
          );
        }
        const restored = block.remoteDetail
          ? {
              ...loaded,
              remoteDetail: {
                ...loaded.remoteDetail,
                ...block.remoteDetail,
              },
            }
          : loaded;
        const bytes = byteSize(restored);
        if (
          bytes <= MAX_CACHE_BYTES &&
          !restored.remoteDetail?.warning &&
          wanted.some((isWanted) => isWanted())
        ) {
          while (
            cacheBytes.current + bytes > MAX_CACHE_BYTES &&
            cache.current.size > 0
          ) {
            const oldestKey = cache.current.keys().next().value;
            if (oldestKey === undefined) break;
            cacheBytes.current -= cache.current.get(oldestKey)!.bytes;
            cache.current.delete(oldestKey);
          }
          cache.current.set(key, { block: restored, bytes });
          cacheBytes.current += bytes;
        }
        return restored;
      })
      .finally(() => pending.current.delete(key));
    pending.current.set(key, { promise, wanted });
    return promise;
  };

  const value = useRef<RemoteToolDetailContextValue | null>(null);
  if (value.current === null) value.current = { load };

  return (
    <RemoteToolDetailContext.Provider value={value.current}>
      {children}
    </RemoteToolDetailContext.Provider>
  );
}

export function useRemoteToolDetail<T extends RemoteToolBlock>(
  projectedBlock: T,
  expanded: boolean,
): {
  block: T;
  loading: boolean;
  error: string | null;
  retry: () => void;
} {
  const context = useContext(RemoteToolDetailContext);
  const [loaded, setLoaded] = useState<{
    key: string;
    block: RemoteToolBlock;
  } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<{
    key: string;
    error: string;
  } | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const generation = useRef(0);
  const key = detailKey(projectedBlock);
  const detail = projectedBlock.remoteDetail;

  useEffect(() => {
    const currentGeneration = ++generation.current;
    if (!expanded || !detail || !detail.available || !context) {
      setLoadingKey(null);
      return;
    }

    setLoadingKey(key);
    setErrorState(null);
    context
      .load(projectedBlock, () => generation.current === currentGeneration)
      .then((block) => {
        if (generation.current === currentGeneration) {
          setLoaded({ key, block });
        }
      })
      .catch((error: unknown) => {
        if (generation.current === currentGeneration) {
          setErrorState({
            key,
            error:
              error instanceof Error
                ? error.message
                : "Could not load tool detail",
          });
        }
      })
      .finally(() => {
        if (generation.current === currentGeneration) setLoadingKey(null);
      });

    return () => {
      generation.current += 1;
    };
  }, [context, detail?.available, expanded, key, retryVersion]);

  const retry = () => setRetryVersion((version) => version + 1);
  const matchingLoaded =
    detail?.available &&
    loaded?.block.type === projectedBlock.type &&
    loaded.block.id === projectedBlock.id &&
    loaded.block.remoteDetail?.messageId === detail.messageId
      ? loaded.key === key
        ? loaded.block
        : {
            ...loaded.block,
            complete: projectedBlock.complete,
            durationMs: projectedBlock.durationMs,
          }
      : null;
  const error = errorState?.key === key ? errorState.error : null;

  return {
    block: (matchingLoaded ?? projectedBlock) as T,
    loading: loadingKey === key,
    error,
    retry,
  };
}
