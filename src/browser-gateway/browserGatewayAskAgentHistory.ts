import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type {
  BrowserGatewayAskAgentHistorySnapshot,
  BrowserGatewayAskAgentPrivateModelHistory,
} from "./browserGatewayAskAgentSessionStore.js";

import { CORE_WEB_ACCESS_DEFAULT_MAX_REPLAY_BYTES_PER_TURN } from "../core/webAccess.js";
import type { CoreModelMessage } from "../core/modelRuntime.js";
import { writeTextFileAtomic } from "./atomicFile.js";

const HISTORY_DIR = path.join(os.homedir(), ".agentlink");
const HISTORY_PATH = path.join(
  HISTORY_DIR,
  "browser-gateway-ask-agent-history.json",
);

function normalizePrivateModelHistory(
  value: unknown,
): BrowserGatewayAskAgentPrivateModelHistory | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const candidate = value as {
    schemaVersion?: unknown;
    assistantTurns?: unknown;
  };
  if (
    candidate.schemaVersion !== 1 ||
    !Array.isArray(candidate.assistantTurns)
  ) {
    return undefined;
  }
  const assistantTurns = candidate.assistantTurns.flatMap((turn) => {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) return [];
    const item = turn as { messageId?: unknown; messages?: unknown };
    const messageId =
      typeof item.messageId === "string" ? item.messageId.trim() : "";
    if (
      !messageId ||
      !Array.isArray(item.messages) ||
      item.messages.length === 0 ||
      !item.messages.every(isCoreModelMessage)
    ) {
      return [];
    }
    const messages = item.messages;
    const replayBytes = messages.reduce((total, message) => {
      if (!message.providerReplay) return total;
      return total + message.providerReplay.serializedBytes;
    }, 0);
    if (replayBytes > CORE_WEB_ACCESS_DEFAULT_MAX_REPLAY_BYTES_PER_TURN)
      return [];
    return [{ messageId, messages }];
  });
  return assistantTurns.length > 0
    ? { schemaVersion: 1, assistantTurns }
    : undefined;
}

function isCoreModelMessage(value: unknown): value is CoreModelMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<CoreModelMessage>;
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (typeof message.content !== "string" && !Array.isArray(message.content)) {
    return false;
  }
  const replay = message.providerReplay;
  if (!replay) return true;
  return (
    typeof replay.providerId === "string" &&
    Number.isInteger(replay.codecVersion) &&
    replay.codecVersion > 0 &&
    Number.isInteger(replay.serializedBytes) &&
    replay.serializedBytes >= 0 &&
    replay.serializedBytes <= CORE_WEB_ACCESS_DEFAULT_MAX_REPLAY_BYTES_PER_TURN
  );
}

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
            generateImageApproved?: unknown;
            privateModelHistory?: unknown;
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
          const privateModelHistory = normalizePrivateModelHistory(
            item.privateModelHistory,
          );
          return {
            id,
            title,
            createdAt,
            lastActiveAt,
            messages,
            nextMessageSequence,
            ...(item.generateImageApproved === true
              ? { generateImageApproved: true }
              : {}),
            ...(privateModelHistory ? { privateModelHistory } : {}),
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
  await writeTextFileAtomic(
    filePath,
    JSON.stringify(snapshot, null, 2) + "\n",
    {
      mode: 0o600,
    },
  );
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
