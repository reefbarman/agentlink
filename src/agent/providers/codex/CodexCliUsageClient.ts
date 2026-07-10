import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as readline from "readline";

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  planType: string | null;
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  individualLimit: {
    limit: string;
    used: string;
    remainingPercent: number;
    resetsAt: number;
  } | null;
  rateLimitReachedType: string | null;
}

export interface CodexSubscriptionUsage {
  account: {
    type: "chatgpt" | "apiKey" | "amazonBedrock" | "unknown";
    email: string | null;
    planType: string | null;
  };
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot> | null;
  rateLimitResetCredits: { availableCount: number } | null;
  tokenUsage: {
    summary: {
      lifetimeTokens: number | null;
      peakDailyTokens: number | null;
      longestRunningTurnSec: number | null;
      currentStreakDays: number | null;
      longestStreakDays: number | null;
    };
    dailyUsageBuckets: Array<{ startDate: string; tokens: number }> | null;
  };
}

export type CodexCliUsageResult =
  | { available: true; usage: CodexSubscriptionUsage }
  | { available: false; reason: string };

type SpawnCodex = () => ChildProcessWithoutNullStreams;

const REQUEST_TIMEOUT_MS = 8_000;

function defaultSpawnCodex(): ChildProcessWithoutNullStreams {
  return spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

/**
 * Queries subscription usage through an installed Codex CLI. The CLI is an
 * optional runtime capability: missing executables, old protocol versions, and
 * unsigned-in accounts all resolve to `available: false`.
 */
export async function queryCodexCliUsage(options?: {
  spawnCodex?: SpawnCodex;
  timeoutMs?: number;
}): Promise<CodexCliUsageResult> {
  const spawnCodex = options?.spawnCodex ?? defaultSpawnCodex;
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;

  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnCodex();
    } catch (error) {
      resolve({ available: false, reason: errorMessage(error) });
      return;
    }

    let settled = false;
    let rateLimits: Omit<CodexSubscriptionUsage, "tokenUsage"> | null = null;
    let tokenUsage: CodexSubscriptionUsage["tokenUsage"] | null = null;
    let account: CodexSubscriptionUsage["account"] | null = null;

    const finish = (result: CodexCliUsageResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      if (!child.killed) child.kill();
      resolve(result);
    };

    const maybeFinish = (): void => {
      if (rateLimits && tokenUsage && account) {
        finish({
          available: true,
          usage: { ...rateLimits, tokenUsage, account },
        });
      }
    };

    const timer = setTimeout(() => {
      finish({ available: false, reason: "Codex usage query timed out" });
    }, timeoutMs);

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }

      if (
        message.error &&
        (message.id === 2 || message.id === 3 || message.id === 4)
      ) {
        finish({
          available: false,
          reason: message.error.message ?? "Codex rejected the usage query",
        });
        return;
      }

      if (message.id === 1) {
        send(child, { method: "initialized", params: {} });
        send(child, { method: "account/rateLimits/read", id: 2 });
        send(child, { method: "account/usage/read", id: 3 });
        send(child, {
          method: "account/read",
          id: 4,
          params: { refreshToken: false },
        });
      } else if (message.id === 2) {
        rateLimits = message.result as typeof rateLimits;
        maybeFinish();
      } else if (message.id === 3) {
        tokenUsage = message.result as typeof tokenUsage;
        maybeFinish();
      } else if (message.id === 4) {
        const result = message.result as {
          account?:
            | { type: "chatgpt"; email: string | null; planType: string }
            | { type: "apiKey" }
            | { type: "amazonBedrock" };
        };
        const value = result.account;
        account = value
          ? {
              type: value.type,
              email: value.type === "chatgpt" ? value.email : null,
              planType: value.type === "chatgpt" ? value.planType : null,
            }
          : { type: "unknown", email: null, planType: null };
        maybeFinish();
      }
    });

    child.once("error", (error) => {
      finish({ available: false, reason: errorMessage(error) });
    });
    child.once("exit", (code) => {
      if (!settled) {
        finish({
          available: false,
          reason: `Codex app-server exited before returning usage${code === null ? "" : ` (code ${code})`}`,
        });
      }
    });

    send(child, {
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "agentlink",
          title: "AgentLink",
          version: "1",
        },
      },
    });
  });
}

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
