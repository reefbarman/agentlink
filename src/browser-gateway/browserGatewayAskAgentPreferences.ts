import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { ReasoningEffort } from "../agent/webview/types.js";
import { randomUUID } from "crypto";

const PREFERENCES_DIR = path.join(os.homedir(), ".agentlink");
const PREFERENCES_PATH = path.join(
  PREFERENCES_DIR,
  "browser-gateway-ask-agent-preferences.json",
);

export interface BrowserGatewayAskAgentPreferencesSnapshot {
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

function normalizePreferences(
  value: unknown,
): BrowserGatewayAskAgentPreferencesSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const candidate = value as {
    model?: unknown;
    reasoningEffort?: unknown;
  };
  return {
    model:
      typeof candidate.model === "string" && candidate.model.trim()
        ? candidate.model.trim()
        : undefined,
    reasoningEffort: isReasoningEffort(candidate.reasoningEffort)
      ? candidate.reasoningEffort
      : undefined,
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
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  await fs.writeFile(tmpPath, JSON.stringify(preferences, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.rename(tmpPath, filePath);
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
