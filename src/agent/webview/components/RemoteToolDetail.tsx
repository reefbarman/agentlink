import type {
  ContentBlock,
  RemoteDisplayImageDetail,
} from "@agentlink/protocol/chat-transcript";
import { useContext, useEffect, useRef, useState } from "preact/hooks";

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
  loadDisplayImage: (reference: RemoteDisplayImageDetail) => Promise<string>;
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

function displayImageKey(reference: RemoteDisplayImageDetail): string {
  return `${reference.messageId}:${reference.contentRevision}:${reference.index}`;
}

export function RemoteToolDetailProvider(props: {
  scopeKey: string;
  loadDetail: (block: RemoteToolBlock) => Promise<RemoteToolBlock>;
  loadDisplayImage?: (reference: RemoteDisplayImageDetail) => Promise<string>;
  children: preact.ComponentChildren;
}) {
  return (
    <RemoteToolDetailScopeProvider
      key={props.scopeKey}
      loadDetail={props.loadDetail}
      loadDisplayImage={props.loadDisplayImage}
    >
      {props.children}
    </RemoteToolDetailScopeProvider>
  );
}

function RemoteToolDetailScopeProvider({
  loadDetail,
  loadDisplayImage,
  children,
}: {
  loadDetail: (block: RemoteToolBlock) => Promise<RemoteToolBlock>;
  loadDisplayImage?: (reference: RemoteDisplayImageDetail) => Promise<string>;
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
  const imageLoader = useRef(loadDisplayImage);
  imageLoader.current = loadDisplayImage;
  const imageCache = useRef(new Map<string, string>());
  const imageCacheBytes = useRef(0);
  const pendingImages = useRef(new Map<string, Promise<string>>());

  const loadImage = (reference: RemoteDisplayImageDetail): Promise<string> => {
    const key = displayImageKey(reference);
    const cached = imageCache.current.get(key);
    if (cached !== undefined) {
      imageCache.current.delete(key);
      imageCache.current.set(key, cached);
      return Promise.resolve(cached);
    }
    const existing = pendingImages.current.get(key);
    if (existing) return existing;
    const load = imageLoader.current;
    if (!load) {
      return Promise.reject(new Error("Image previews are unavailable."));
    }
    const promise = load(reference)
      .then((src) => {
        const bytes = src.length;
        if (bytes <= MAX_CACHE_BYTES) {
          while (
            imageCacheBytes.current + bytes > MAX_CACHE_BYTES &&
            imageCache.current.size > 0
          ) {
            const oldestKey = imageCache.current.keys().next().value;
            if (oldestKey === undefined) break;
            imageCacheBytes.current -=
              imageCache.current.get(oldestKey)!.length;
            imageCache.current.delete(oldestKey);
          }
          imageCache.current.set(key, src);
          imageCacheBytes.current += bytes;
        }
        return src;
      })
      .finally(() => pendingImages.current.delete(key));
    pendingImages.current.set(key, promise);
    return promise;
  };

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
  if (value.current === null)
    value.current = { load, loadDisplayImage: loadImage };

  return (
    <RemoteToolDetailContext.Provider value={value.current}>
      {children}
    </RemoteToolDetailContext.Provider>
  );
}

/**
 * Resolves a display image's `src`, loading relay-backed images lazily. Images
 * that already carry a data URL are returned unchanged.
 */
export function useRemoteDisplayImage<
  T extends { src: string; remoteDetail?: RemoteDisplayImageDetail },
>(image: T): { image: T; loading: boolean; error: string | null } {
  const context = useContext(RemoteToolDetailContext);
  const reference = image.src ? undefined : image.remoteDetail;
  const key = reference ? displayImageKey(reference) : null;
  const [state, setState] = useState<{
    key: string;
    src?: string;
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (!key || !reference || !context) return;
    let current = true;
    context
      .loadDisplayImage(reference)
      .then((src) => {
        if (current) setState({ key, src });
      })
      .catch((error: unknown) => {
        if (current)
          setState({
            key,
            error:
              error instanceof Error
                ? error.message
                : "Could not load image preview",
          });
      });
    return () => {
      current = false;
    };
  }, [context, key]);

  if (!key) return { image, loading: false, error: null };
  const matching = state?.key === key ? state : null;
  if (!context && !matching) {
    return { image, loading: false, error: "Image preview is unavailable." };
  }
  return {
    image: matching?.src ? { ...image, src: matching.src } : image,
    loading: !matching,
    error: matching?.error ?? null,
  };
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
