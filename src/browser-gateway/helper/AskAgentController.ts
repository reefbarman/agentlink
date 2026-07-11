import type {
  BrowserGatewayAskAgentHistorySnapshot,
  BrowserGatewayAskAgentSnapshot,
} from "../browserGatewayAskAgentSessionStore.js";

import type { AskAgentSnapshotPublication } from "./askAgentSnapshotPublicationQueue.js";
import type { BrowserGatewayAskAgentPreferencesSnapshot } from "../browserGatewayAskAgentPreferences.js";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer TItem)[]
    ? readonly DeepReadonly<TItem>[]
    : T extends object
      ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
      : T;

export type AskAgentControllerSnapshot =
  DeepReadonly<BrowserGatewayAskAgentSnapshot>;

export type AskAgentControllerPublication = DeepReadonly<
  AskAgentSnapshotPublication<AskAgentControllerSnapshot>
>;

export function freezeAskAgentControllerSnapshot(
  snapshot: BrowserGatewayAskAgentSnapshot,
): AskAgentControllerSnapshot {
  const cloned = structuredClone(snapshot);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(cloned);
  return cloned;
}

export interface AskAgentController {
  restoreState(
    preferences: BrowserGatewayAskAgentPreferencesSnapshot,
    history: BrowserGatewayAskAgentHistorySnapshot,
  ): void;
  buildSnapshot(): Promise<AskAgentControllerSnapshot>;
  publishSnapshot(
    snapshot: AskAgentControllerSnapshot,
  ): Promise<AskAgentControllerPublication>;
  cancelActiveTurn(): Promise<AskAgentControllerPublication | null>;
  dispose(): Promise<void>;
}
