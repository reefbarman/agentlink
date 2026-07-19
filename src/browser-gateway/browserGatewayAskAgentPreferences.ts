import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { ReasoningEffort } from "../agent/webview/types.js";
import { isCoreReasoningEffort } from "../core/modelCatalog.js";
import {
  normalizeCoreWebAccessSettings,
  type CoreWebAccessSettings,
} from "../core/webAccess.js";
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
  reasoningEffort?: ReasoningEffort;
  webPolicy?: BrowserGatewayAskAgentWebPolicyCache;
}

function normalizePreferences(
  value: unknown,
): BrowserGatewayAskAgentPreferencesSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const candidate = value as {
    model?: unknown;
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
}

export function getBrowserGatewayAskAgentPreferencesPath(): string {
  return PREFERENCES_PATH;
}

export class BrowserGatewayAskAgentPreferencesStore {
  private readonly filePath: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: BrowserGatewayAskAgentPreferencesStoreOptions = {}) {
    this.filePath = options.filePath ?? PREFERENCES_PATH;
  }

  getPath(): string {
    return this.filePath;
  }

  async read(): Promise<BrowserGatewayAskAgentPreferencesSnapshot> {
    await this.pending.catch(() => undefined);
    return await readPreferencesFile(this.filePath);
  }

  async update(
    patch: BrowserGatewayAskAgentPreferencesSnapshot,
  ): Promise<BrowserGatewayAskAgentPreferencesSnapshot> {
    let nextSnapshot: BrowserGatewayAskAgentPreferencesSnapshot = {};
    await this.enqueue(async () => {
      const current = await readPreferencesFile(this.filePath);
      nextSnapshot = normalizePreferences({ ...current, ...patch });
      await writePreferencesFile(this.filePath, nextSnapshot);
    });
    return nextSnapshot;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.pending.then(task, task);
    this.pending = next.catch(() => undefined);
    return next;
  }
}
