import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { BrowserGatewayAskAgentHistorySnapshot } from "./browserGatewayAskAgentSessionStore.js";
import { randomUUID } from "crypto";

const HISTORY_DIR = path.join(os.homedir(), ".agentlink");
const HISTORY_PATH = path.join(
  HISTORY_DIR,
  "browser-gateway-ask-agent-history.json",
);

function normalizeHistorySnapshot(
  value: unknown,
): BrowserGatewayAskAgentHistorySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { sessions: [] };
  }
  const candidate = value as {
    activeSessionId?: unknown;
    sessions?: unknown;
  };
  const sessions = Array.isArray(candidate.sessions)
    ? candidate.sessions
        .map((session) => {
          if (
            !session ||
            typeof session !== "object" ||
            Array.isArray(session)
          ) {
            return null;
          }
          const item = session as {
            id?: unknown;
            title?: unknown;
            createdAt?: unknown;
            lastActiveAt?: unknown;
            messages?: unknown;
            nextMessageSequence?: unknown;
          };
          const id = typeof item.id === "string" ? item.id.trim() : "";
          if (!id) return null;
          const title =
            typeof item.title === "string" && item.title.trim()
              ? item.title.trim()
              : "Ask Agent";
          const createdAt =
            typeof item.createdAt === "number" &&
            Number.isFinite(item.createdAt)
              ? item.createdAt
              : Date.now();
          const lastActiveAt =
            typeof item.lastActiveAt === "number" &&
            Number.isFinite(item.lastActiveAt)
              ? item.lastActiveAt
              : createdAt;
          const messages = Array.isArray(item.messages) ? item.messages : [];
          const nextMessageSequence =
            typeof item.nextMessageSequence === "number" &&
            Number.isInteger(item.nextMessageSequence) &&
            item.nextMessageSequence > 0
              ? item.nextMessageSequence
              : messages.length + 1;
          return {
            id,
            title,
            createdAt,
            lastActiveAt,
            messages,
            nextMessageSequence,
          };
        })
        .filter((session) => session !== null)
    : [];
  const activeSessionId =
    typeof candidate.activeSessionId === "string" &&
    sessions.some((session) => session.id === candidate.activeSessionId)
      ? candidate.activeSessionId
      : sessions[0]?.id;
  return {
    ...(activeSessionId ? { activeSessionId } : {}),
    sessions,
  };
}

async function readHistoryFile(
  filePath: string,
): Promise<BrowserGatewayAskAgentHistorySnapshot> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return normalizeHistorySnapshot(JSON.parse(raw) as unknown);
  } catch {
    return { sessions: [] };
  }
}

async function writeHistoryFile(
  filePath: string,
  snapshot: BrowserGatewayAskAgentHistorySnapshot,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.rename(tmpPath, filePath);
}

export interface BrowserGatewayAskAgentHistoryStoreOptions {
  filePath?: string;
}

export function getBrowserGatewayAskAgentHistoryPath(): string {
  return HISTORY_PATH;
}

export class BrowserGatewayAskAgentHistoryStore {
  private readonly filePath: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: BrowserGatewayAskAgentHistoryStoreOptions = {}) {
    this.filePath = options.filePath ?? HISTORY_PATH;
  }

  getPath(): string {
    return this.filePath;
  }

  async read(): Promise<BrowserGatewayAskAgentHistorySnapshot> {
    await this.pending.catch(() => undefined);
    return await readHistoryFile(this.filePath);
  }

  async write(snapshot: BrowserGatewayAskAgentHistorySnapshot): Promise<void> {
    await this.enqueue(async () => {
      await writeHistoryFile(this.filePath, normalizeHistorySnapshot(snapshot));
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.pending.then(task, task);
    this.pending = next.catch(() => undefined);
    return next;
  }
}
