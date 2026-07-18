import * as path from "node:path";

import type { handleCompose } from "./composeRuntime.js";
import { pathToFileURL } from "node:url";

interface ComposeRuntimeModule {
  handleCompose: typeof handleCompose;
}

const runtimeModules = new Map<string, Promise<ComposeRuntimeModule>>();

export function loadComposeRuntime(
  extensionFsPath: string,
): Promise<ComposeRuntimeModule> {
  const runtimeUrl = pathToFileURL(
    path.join(extensionFsPath, "dist", "compose-runtime.mjs"),
  ).href;
  const cached = runtimeModules.get(runtimeUrl);
  if (cached) return cached;

  const loading = import(runtimeUrl) as Promise<ComposeRuntimeModule>;
  runtimeModules.set(runtimeUrl, loading);
  void loading.catch(() => runtimeModules.delete(runtimeUrl));
  return loading;
}
