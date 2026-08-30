import type { ApprovalRequest } from "../../approvals/webview/types";
import type { BgSessionInfo } from "@agentlink/protocol/background-result";
import type { ChatMessage } from "@agentlink/protocol/chat-transcript";

export const BROWSER_GATEWAY_NOTIFICATION_PREFERENCE_KEY =
  "agentlink.browserGateway.notifications.v1";
export const BROWSER_GATEWAY_NOTIFICATION_PROMPT_DISMISSED_KEY =
  "agentlink.browserGateway.notifications.promptDismissed.v1";

const MAX_NOTIFICATION_SCOPES = 64;
const MAX_SEEN_NOTIFICATION_KEYS_PER_SCOPE = 256;

export type BrowserGatewayNotificationPreference = "off" | "attention" | "all";

export type BrowserGatewayNotificationKind =
  | "approval"
  | "question"
  | "task_completed"
  | "task_waiting"
  | "task_blocked"
  | "task_cancelled"
  | "background";

export interface BrowserGatewayNotificationCandidate {
  key: string;
  kind: BrowserGatewayNotificationKind;
  sessionId: string;
  title: string;
  body: string;
}

export interface BrowserGatewayNotificationSnapshot {
  approval: ApprovalRequest | null;
  question: { id: string } | null;
  foreground: {
    sessionId: string;
    projectedMessages: ChatMessage[];
  } | null;
  background: BgSessionInfo[];
}

export interface BrowserGatewayNotificationBrowser {
  isDocumentVisible(): boolean;
  show(candidate: BrowserGatewayNotificationCandidate): Promise<void>;
}

function isPreference(
  value: unknown,
): value is BrowserGatewayNotificationPreference {
  return value === "off" || value === "attention" || value === "all";
}

export function readBrowserGatewayNotificationPreference(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): BrowserGatewayNotificationPreference {
  try {
    const value = storage.getItem(BROWSER_GATEWAY_NOTIFICATION_PREFERENCE_KEY);
    return isPreference(value) ? value : "off";
  } catch {
    return "off";
  }
}

export function writeBrowserGatewayNotificationPreference(
  preference: BrowserGatewayNotificationPreference,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  try {
    storage.setItem(BROWSER_GATEWAY_NOTIFICATION_PREFERENCE_KEY, preference);
  } catch {
    // Browser storage is a convenience preference, not a required dependency.
  }
}

export function browserGatewayNotificationPromptDismissed(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): boolean {
  try {
    return (
      storage.getItem(BROWSER_GATEWAY_NOTIFICATION_PROMPT_DISMISSED_KEY) ===
      "true"
    );
  } catch {
    return false;
  }
}

export function writeBrowserGatewayNotificationPromptDismissed(
  dismissed: boolean,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  try {
    storage.setItem(
      BROWSER_GATEWAY_NOTIFICATION_PROMPT_DISMISSED_KEY,
      dismissed ? "true" : "false",
    );
  } catch {
    // Browser storage is a convenience preference, not a required dependency.
  }
}

export function notificationPermissionState():
  | NotificationPermission
  | "unavailable" {
  if (typeof Notification === "undefined") return "unavailable";
  return Notification.permission;
}

export function notificationsAvailable(): boolean {
  return (
    typeof Notification !== "undefined" &&
    typeof window !== "undefined" &&
    window.isSecureContext
  );
}

export async function requestBrowserGatewayNotificationPermission(): Promise<
  NotificationPermission | "unavailable"
> {
  if (!notificationsAvailable()) return "unavailable";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

export async function registerBrowserGatewayNotificationServiceWorker(): Promise<void> {
  if (
    !notificationsAvailable() ||
    typeof navigator === "undefined" ||
    !navigator.serviceWorker
  ) {
    return;
  }

  try {
    await navigator.serviceWorker.register(
      "/browser-gateway-notifications.js",
      {
        type: "module",
      },
    );
  } catch {
    // Notifications still work through the page API where the browser supports it.
  }
}

export async function showBrowserGatewayNotification(
  candidate: BrowserGatewayNotificationCandidate,
): Promise<void> {
  if (notificationPermissionState() !== "granted") return;

  const options: NotificationOptions = {
    body: candidate.body,
    icon: "/agentlink-icon.png",
    tag: candidate.key,
  };

  try {
    if (navigator.serviceWorker?.controller) {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(candidate.title, options);
      return;
    }
  } catch {
    // Fall through to the page-bound API, which remains the desktop fallback.
  }

  try {
    new Notification(candidate.title, options);
  } catch {
    // Some mobile browsers only support worker notifications. The next event after
    // service-worker activation can use the persistent path above.
  }
}

function finalMarkerCandidates(
  foreground: BrowserGatewayNotificationSnapshot["foreground"],
): BrowserGatewayNotificationCandidate[] {
  if (!foreground) return [];
  return foreground.projectedMessages.flatMap(
    (message): BrowserGatewayNotificationCandidate[] => {
      const marker = message.finalMarker;
      if (message.role !== "assistant" || !marker) return [];

      switch (marker.status) {
        case "completed":
          return [
            {
              key: `task:${foreground.sessionId}:${message.id}:completed`,
              kind: "task_completed",
              sessionId: foreground.sessionId,
              title: "AgentLink task complete",
              body: "A task finished. Review it in AgentLink.",
            },
          ];
        case "waiting_for_user":
          return [
            {
              key: `task:${foreground.sessionId}:${message.id}:waiting_for_user`,
              kind: "task_waiting",
              sessionId: foreground.sessionId,
              title: "AgentLink needs input",
              body: "A task is waiting for your response.",
            },
          ];
        case "blocked":
          return [
            {
              key: `task:${foreground.sessionId}:${message.id}:blocked`,
              kind: "task_blocked",
              sessionId: foreground.sessionId,
              title: "AgentLink task blocked",
              body: "A task needs your attention.",
            },
          ];
        case "cancelled":
          return [
            {
              key: `task:${foreground.sessionId}:${message.id}:cancelled`,
              kind: "task_cancelled",
              sessionId: foreground.sessionId,
              title: "AgentLink task cancelled",
              body: "A task was cancelled. Review it in AgentLink.",
            },
          ];
      }
    },
  );
}

export function collectBrowserGatewayNotificationCandidates(
  snapshot: BrowserGatewayNotificationSnapshot,
): BrowserGatewayNotificationCandidate[] {
  const candidates: BrowserGatewayNotificationCandidate[] = [];
  const foregroundSessionId = snapshot.foreground?.sessionId;

  if (snapshot.approval && foregroundSessionId) {
    candidates.push({
      key: `approval:${foregroundSessionId}:${snapshot.approval.id}`,
      kind: "approval",
      sessionId: foregroundSessionId,
      title: "AgentLink needs approval",
      body: "An agent action is waiting for your approval.",
    });
  }
  if (snapshot.question && foregroundSessionId) {
    candidates.push({
      key: `question:${foregroundSessionId}:${snapshot.question.id}`,
      kind: "question",
      sessionId: foregroundSessionId,
      title: "AgentLink needs input",
      body: "An agent has a question for you.",
    });
  }

  candidates.push(...finalMarkerCandidates(snapshot.foreground));

  for (const session of snapshot.background) {
    for (const event of session.events ?? []) {
      if (event.readAt) continue;
      candidates.push({
        key: `background:${session.id}:${event.id}`,
        kind: "background",
        sessionId: session.id,
        title: "AgentLink background update",
        body: "A background task has an update.",
      });
    }
  }
  return candidates;
}

function preferenceAllows(
  preference: BrowserGatewayNotificationPreference,
  kind: BrowserGatewayNotificationKind,
): boolean {
  if (preference === "all") return true;
  return (
    preference === "attention" && (kind === "approval" || kind === "question")
  );
}

export class BrowserGatewayNotificationTracker {
  private readonly seenKeysByScope = new Map<string, Set<string>>();

  private rememberScope(scopeKey: string, seenKeys: Set<string>): void {
    this.seenKeysByScope.delete(scopeKey);
    this.seenKeysByScope.set(scopeKey, seenKeys);
    while (this.seenKeysByScope.size > MAX_NOTIFICATION_SCOPES) {
      const oldestScopeKey = this.seenKeysByScope.keys().next().value;
      if (!oldestScopeKey) return;
      this.seenKeysByScope.delete(oldestScopeKey);
    }
  }

  private rememberCandidate(seenKeys: Set<string>, key: string): void {
    seenKeys.add(key);
    while (seenKeys.size > MAX_SEEN_NOTIFICATION_KEYS_PER_SCOPE) {
      const oldestKey = seenKeys.keys().next().value;
      if (!oldestKey) return;
      seenKeys.delete(oldestKey);
    }
  }

  async process(params: {
    scopeKey: string;
    snapshot: BrowserGatewayNotificationSnapshot;
    preference: BrowserGatewayNotificationPreference;
    selectedSessionId: string | null;
    browser: BrowserGatewayNotificationBrowser;
  }): Promise<void> {
    const candidates = collectBrowserGatewayNotificationCandidates(
      params.snapshot,
    );
    let seenKeys = this.seenKeysByScope.get(params.scopeKey);
    if (!seenKeys) {
      seenKeys = new Set(candidates.map((candidate) => candidate.key));
      this.rememberScope(params.scopeKey, seenKeys);
      return;
    }
    this.rememberScope(params.scopeKey, seenKeys);

    for (const candidate of candidates) {
      if (seenKeys.has(candidate.key)) continue;
      this.rememberCandidate(seenKeys, candidate.key);
      const selectedAndVisible =
        params.selectedSessionId === candidate.sessionId &&
        params.browser.isDocumentVisible();
      if (
        selectedAndVisible ||
        !preferenceAllows(params.preference, candidate.kind)
      ) {
        continue;
      }
      await params.browser.show(candidate);
    }
  }
}
