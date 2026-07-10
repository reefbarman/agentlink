import { EventEmitter } from "events";
import { PassThrough } from "stream";
import type { ChildProcessWithoutNullStreams } from "child_process";
import { describe, expect, it } from "vitest";
import { queryCodexCliUsage } from "./CodexCliUsageClient.js";

function fakeChild(onRequest: (message: Record<string, unknown>) => void) {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let pending = "";
  let killed = false;

  stdin.on("data", (chunk) => {
    pending += chunk.toString();
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      onRequest(JSON.parse(line) as Record<string, unknown>);
    }
  });

  const child = events as unknown as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    get killed() {
      return killed;
    },
    kill: () => {
      killed = true;
      return true;
    },
  });
  return { child, stdout };
}

describe("queryCodexCliUsage", () => {
  it("returns rate limits and token activity from app-server", async () => {
    let output!: PassThrough;
    const { child, stdout } = fakeChild((message) => {
      const id = message.id;
      if (id === 1) {
        output.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      } else if (id === 2) {
        output.write(
          `${JSON.stringify({
            id: 2,
            result: {
              rateLimits: {
                limitId: "codex",
                limitName: null,
                primary: {
                  usedPercent: 25,
                  windowDurationMins: 300,
                  resetsAt: 1_800_000_000,
                },
                secondary: null,
                planType: "plus",
                credits: null,
                individualLimit: null,
                rateLimitReachedType: null,
              },
              rateLimitsByLimitId: null,
              rateLimitResetCredits: null,
            },
          })}\n`,
        );
      } else if (id === 3) {
        output.write(
          `${JSON.stringify({
            id: 3,
            result: {
              summary: {
                lifetimeTokens: 1234,
                peakDailyTokens: 500,
                longestRunningTurnSec: null,
                currentStreakDays: 2,
                longestStreakDays: 4,
              },
              dailyUsageBuckets: [{ startDate: "2026-07-10", tokens: 42 }],
            },
          })}\n`,
        );
      } else if (id === 4) {
        output.write(
          `${JSON.stringify({
            id: 4,
            result: {
              account: {
                type: "chatgpt",
                email: "person@example.com",
                planType: "plus",
              },
              requiresOpenaiAuth: true,
            },
          })}\n`,
        );
      }
    });
    output = stdout;

    const result = await queryCodexCliUsage({
      spawnCodex: () => child,
      timeoutMs: 500,
    });

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.usage.rateLimits.primary?.usedPercent).toBe(25);
      expect(result.usage.tokenUsage.summary.lifetimeTokens).toBe(1234);
      expect(result.usage.account).toEqual({
        type: "chatgpt",
        email: "person@example.com",
        planType: "plus",
      });
    }
  });

  it("is unavailable when the CLI cannot be spawned", async () => {
    const result = await queryCodexCliUsage({
      spawnCodex: () => {
        throw new Error("spawn codex ENOENT");
      },
    });

    expect(result).toEqual({
      available: false,
      reason: "spawn codex ENOENT",
    });
  });

  it("is unavailable when app-server rejects the method", async () => {
    let output!: PassThrough;
    const { child, stdout } = fakeChild((message) => {
      if (message.id === 1) {
        output.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      } else if (message.id === 2) {
        output.write(
          `${JSON.stringify({ id: 2, error: { message: "Method not found" } })}\n`,
        );
      }
    });
    output = stdout;

    await expect(
      queryCodexCliUsage({ spawnCodex: () => child, timeoutMs: 500 }),
    ).resolves.toEqual({ available: false, reason: "Method not found" });
  });
});
