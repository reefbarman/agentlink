import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { CoreWebAccessSettings } from "@agentlink/protocol/web-access-policy";
import type { ChatReasoningEffort as ReasoningEffort } from "@agentlink/protocol/chat-catalog";
import { SessionPreferencesStore } from "@agentlink/node-host";
import { isCoreReasoningEffort } from "@agentlink/protocol/model-catalog";
import { normalizeCoreWebAccessSettings } from "@agentlink/core/web-access";
import { writeTextFileAtomic } from "./atomicFile.js";

const PREFERENCES_DIR = path.join(os.homedir(), ".agentlink");
const PREFERENCES_PATH = path.join(
  PREFERENCES_DIR,
  "browser-gateway-ask-agent-preferences.json",
);

export interface BrowserGatewayAskAgentWebPolicyCache {
  settings: CoreWebAccessSettings;
  sourceInstanceId?: string;
  sourceRevision?: string;
  updatedAt: number;
}

export interface BrowserGatewayAskAgentPreferencesSnapshot {
  model?: string;
  modelOwnerId?: string;
  reasoningEffort?: ReasoningEffort;
  webPolicy?: BrowserGatewayAskAgentWebPolicyCache;
}

function normalizePreferences(
  value: unknown,
): BrowserGatewayAskAgentPreferencesSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const candidate = value as {
    model?: unknown;
    modelOwnerId?: unknown;
    reasoningEffort?: unknown;
    webPolicy?: unknown;
  };
  let webPolicy: BrowserGatewayAskAgentWebPolicyCache | undefined;
  if (
    candidate.webPolicy &&
    typeof candidate.webPolicy === "object" &&
    !Array.isArray(candidate.webPolicy)
  ) {
    const policy = candidate.webPolicy as Record<string, unknown>;
    try {
      if (typeof policy.updatedAt === "number" && policy.updatedAt > 0) {
        webPolicy = {
          settings: normalizeCoreWebAccessSettings(
            policy.settings as Partial<CoreWebAccessSettings>,
          ),
          sourceInstanceId:
            typeof policy.sourceInstanceId === "string"
              ? policy.sourceInstanceId
              : undefined,
          sourceRevision:
            typeof policy.sourceRevision === "string"
              ? policy.sourceRevision
              : undefined,
          updatedAt: policy.updatedAt,
        };
      }
    } catch {
      webPolicy = undefined;
    }
  }
  return {
    model:
      typeof candidate.model === "string" && candidate.model.trim()
        ? candidate.model.trim()
        : undefined,
    modelOwnerId:
      typeof candidate.modelOwnerId === "string" &&
      candidate.modelOwnerId.trim()
        ? candidate.modelOwnerId.trim()
        : undefined,
    reasoningEffort: isCoreReasoningEffort(candidate.reasoningEffort)
      ? candidate.reasoningEffort
      : undefined,
    webPolicy,
  };
}

async function readPreferencesFile(
  filePath: string,
): Promise<BrowserGatewayAskAgentPreferencesSnapshot> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return normalizePreferences(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

async function writePreferencesFile(
  filePath: string,
  preferences: BrowserGatewayAskAgentPreferencesSnapshot,
): Promise<void> {
  await writeTextFileAtomic(
    filePath,
    JSON.stringify(preferences, null, 2) + "\n",
    { mode: 0o600 },
  );
}

export interface BrowserGatewayAskAgentPreferencesStoreOptions {
  filePath?: string;
  sessionPreferencesStore?: SessionPreferencesStore;
  log?: (message: string) => void;
}

export function getBrowserGatewayAskAgentPreferencesPath(): string {
  return PREFERENCES_PATH;
}

export class BrowserGatewayAskAgentPreferencesStore {
  private readonly filePath: string;
  private readonly sessionPreferencesStore: SessionPreferencesStore;
  private readonly log: (message: string) => void;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: BrowserGatewayAskAgentPreferencesStoreOptions = {}) {
    this.filePath = options.filePath ?? PREFERENCES_PATH;
    this.log = options.log ?? (() => undefined);
    this.sessionPreferencesStore =
      options.sessionPreferencesStore ??
      new SessionPreferencesStore({
        dataRoot: options.filePath ? path.dirname(options.filePath) : undefined,
      });
  }

  getPath(): string {
    return this.filePath;
  }

  async read(): Promise<BrowserGatewayAskAgentPreferencesSnapshot> {
    await this.pending.catch(() => undefined);
    const legacy = await readPreferencesFile(this.filePath);
    const shared = await this.sessionPreferencesStore.read().catch((error) => {
      this.log(`Shared session preferences unavailable: ${String(error)}`);
      return undefined;
    });
    if (!shared) return legacy;
    const model = shared.modeModels.ask ?? legacy.model;
    const reasoningEffort =
      shared.modeReasoningEfforts.ask ?? legacy.reasoningEffort;
    if (
      (legacy.model && !shared.modeModels.ask) ||
      (legacy.reasoningEffort && !shared.modeReasoningEfforts.ask)
    ) {
      await this.sessionPreferencesStore
        .importLegacyIfAbsent({
          modeModels: legacy.model ? { ask: legacy.model } : undefined,
          modeReasoningEfforts: legacy.reasoningEffort
            ? { ask: legacy.reasoningEffort }
            : undefined,
        })
        .catch((error) => {
          this.log(
            `Could not import legacy Ask Agent preferences: ${String(error)}`,
          );
        });
    }
    return {
      ...legacy,
      model,
      modelOwnerId:
        shared.modeModels.ask && shared.modeModels.ask !== legacy.model
          ? undefined
          : legacy.modelOwnerId,
      reasoningEffort,
    };
  }

  async update(
    patch: BrowserGatewayAskAgentPreferencesSnapshot,
  ): Promise<BrowserGatewayAskAgentPreferencesSnapshot> {
    let nextSnapshot: BrowserGatewayAskAgentPreferencesSnapshot = {};
    await this.enqueue(async () => {
      const current = await readPreferencesFile(this.filePath);
      nextSnapshot = normalizePreferences({ ...current, ...patch });
      await writePreferencesFile(this.filePath, nextSnapshot);
      if (patch.model || patch.reasoningEffort) {
        await this.sessionPreferencesStore
          .update({
            modeModels: patch.model ? { ask: patch.model } : undefined,
            modeReasoningEfforts: patch.reasoningEffort
              ? { ask: patch.reasoningEffort }
              : undefined,
          })
          .catch((error) => {
            this.log(
              `Could not update shared Ask Agent preferences: ${String(error)}`,
            );
          });
      }
    });
    return nextSnapshot;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.pending.then(task, task);
    this.pending = next.catch(() => undefined);
    return next;
  }
}
