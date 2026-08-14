import {
  BrowserGatewayNotificationTracker,
  browserGatewayNotificationPromptDismissed,
  collectBrowserGatewayNotificationCandidates,
  readBrowserGatewayNotificationPreference,
  writeBrowserGatewayNotificationPreference,
  writeBrowserGatewayNotificationPromptDismissed,
  type BrowserGatewayNotificationCandidate,
  type BrowserGatewayNotificationSnapshot,
} from "./browserGatewayNotifications";
import { describe, expect, it, vi } from "vitest";

function snapshot(
  overrides: Partial<BrowserGatewayNotificationSnapshot> = {},
): BrowserGatewayNotificationSnapshot {
  return {
    approval: null,
    question: null,
    foreground: {
      sessionId: "session-1",
      projectedMessages: [],
    },
    background: [],
    ...overrides,
  };
}

function browser(visible = false) {
  const shown: BrowserGatewayNotificationCandidate[] = [];
  return {
    shown,
    browser: {
      isDocumentVisible: () => visible,
      show: vi.fn(async (candidate: BrowserGatewayNotificationCandidate) => {
        shown.push(candidate);
      }),
    },
  };
}

describe("browser gateway notifications", () => {
  it("uses generic notification content for approval, questions, and final task statuses", () => {
    const candidates = collectBrowserGatewayNotificationCandidates(
      snapshot({
        approval: { id: "approval-1", kind: "write" },
        question: { id: "question-1" },
        foreground: {
          sessionId: "session-1",
          projectedMessages: [
            {
              id: "final-1",
              role: "assistant",
              content: "private result text",
              timestamp: 1,
              blocks: [],
              finalMarker: {
                status: "completed",
                summary: "Private completion detail",
                source: "tool",
              },
            },
          ],
        },
      }),
    );

    expect(candidates).toMatchObject([
      {
        kind: "approval",
        title: "AgentLink needs approval",
        body: "An agent action is waiting for your approval.",
      },
      {
        kind: "question",
        title: "AgentLink needs input",
        body: "An agent has a question for you.",
      },
      {
        kind: "task_completed",
        title: "AgentLink task complete",
        body: "A task finished. Review it in AgentLink.",
      },
    ]);
    expect(JSON.stringify(candidates)).not.toContain("private result text");
    expect(JSON.stringify(candidates)).not.toContain(
      "Private completion detail",
    );
  });

  it("baselines the first snapshot then notifies once for a newly pending approval", async () => {
    const tracker = new BrowserGatewayNotificationTracker();
    const target = browser();

    await tracker.process({
      scopeKey: "instance-1:session-1",
      snapshot: snapshot({ approval: { id: "existing", kind: "write" } }),
      preference: "attention",
      selectedSessionId: null,
      browser: target.browser,
    });
    await tracker.process({
      scopeKey: "instance-1:session-1",
      snapshot: snapshot({ approval: { id: "new", kind: "write" } }),
      preference: "attention",
      selectedSessionId: null,
      browser: target.browser,
    });
    await tracker.process({
      scopeKey: "instance-1:session-1",
      snapshot: snapshot({ approval: { id: "new", kind: "write" } }),
      preference: "attention",
      selectedSessionId: null,
      browser: target.browser,
    });

    expect(target.shown).toHaveLength(1);
    expect(target.shown[0]).toMatchObject({
      key: "approval:session-1:new",
      kind: "approval",
    });
  });

  it("suppresses attention notifications for the visible selected session", async () => {
    const tracker = new BrowserGatewayNotificationTracker();
    const target = browser(true);

    await tracker.process({
      scopeKey: "instance-1:session-1",
      snapshot: snapshot(),
      preference: "attention",
      selectedSessionId: "session-1",
      browser: target.browser,
    });
    await tracker.process({
      scopeKey: "instance-1:session-1",
      snapshot: snapshot({ question: { id: "question-1" } }),
      preference: "attention",
      selectedSessionId: "session-1",
      browser: target.browser,
    });

    expect(target.shown).toEqual([]);
  });

  it("notifies for an explicit final marker in all-updates mode but not ordinary idle", async () => {
    const tracker = new BrowserGatewayNotificationTracker();
    const target = browser();

    await tracker.process({
      scopeKey: "instance-1:session-1",
      snapshot: snapshot(),
      preference: "all",
      selectedSessionId: null,
      browser: target.browser,
    });
    await tracker.process({
      scopeKey: "instance-1:session-1",
      snapshot: snapshot({
        foreground: {
          sessionId: "session-1",
          projectedMessages: [
            {
              id: "final-1",
              role: "assistant",
              content: "Done",
              timestamp: 1,
              blocks: [],
              finalMarker: { status: "completed", source: "tool" },
            },
          ],
        },
      }),
      preference: "all",
      selectedSessionId: null,
      browser: target.browser,
    });

    expect(target.shown).toHaveLength(1);
    expect(target.shown[0]).toMatchObject({ kind: "task_completed" });
  });

  it("persists notification prompt dismissal separately from the alert preference", () => {
    const entries = new Map<string, string>();
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    };

    expect(browserGatewayNotificationPromptDismissed(storage)).toBe(false);
    writeBrowserGatewayNotificationPromptDismissed(true, storage);
    expect(browserGatewayNotificationPromptDismissed(storage)).toBe(true);
    writeBrowserGatewayNotificationPromptDismissed(false, storage);
    expect(browserGatewayNotificationPromptDismissed(storage)).toBe(false);
  });

  it("persists only recognized preferences and falls back safely", () => {
    const entries = new Map<string, string>();
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    };

    expect(readBrowserGatewayNotificationPreference(storage)).toBe("off");
    writeBrowserGatewayNotificationPreference("all", storage);
    expect(readBrowserGatewayNotificationPreference(storage)).toBe("all");
    entries.set("agentlink.browserGateway.notifications.v1", "unknown");
    expect(readBrowserGatewayNotificationPreference(storage)).toBe("off");
  });
});
