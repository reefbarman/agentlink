import { errorText, requestJson } from "./AssistantProjects";
import { useEffect, useRef, useState } from "preact/hooks";

/**
 * Notifications for the AgentLink Assistant web app.
 *
 * - `push`: Web Push. The server sends inbox entries to this device even
 *   with every tab closed; the service worker shows them.
 * - `local`: no push service (the desktop app's Assistant view), so new
 *   inbox entries are shown while the Assistant is open.
 * - `install`: iPhone and iPad Safari only get push once the Assistant is
 *   added to the Home Screen and opened from there.
 */

export type NotificationSupport = "push" | "local" | "install" | "none";

/** The service worker posts this when a notification for a chat is clicked. */
export const OPEN_URL_MESSAGE = "agentlink-open-url";
export const SERVICE_WORKER_URL = "/browser-gateway-notifications.js";
export const LOCAL_NOTIFICATIONS_KEY =
  "agentlink.assistant.localNotifications.v1";

/**
 * A notification's or link's coding task or chat (and the inbox entry it
 * came from).
 */
export interface OpenTarget {
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  entryId?: string;
}

interface InboxEntryLike {
  id: string;
  title: string;
  body?: string;
  projectId: string;
  sessionId?: string;
  taskId?: string;
  read: boolean;
}

export interface BrowserSubscription {
  toJSON(): unknown;
  unsubscribe(): Promise<boolean>;
}

/** The browser APIs the settings use; replaced in tests. */
export interface NotificationBrowser {
  readonly support: NotificationSupport;
  /** Running inside the AgentLink desktop app rather than a browser. */
  readonly desktopApp?: boolean;
  permission(): NotificationPermission | "unavailable";
  requestPermission(): Promise<NotificationPermission | "unavailable">;
  currentSubscription(): Promise<BrowserSubscription | null>;
  /** Subscribe (replacing a subscription made with another key). */
  subscribe(publicKey: string): Promise<BrowserSubscription>;
  showLocal(notification: {
    title: string;
    body?: string;
    tag?: string;
    onClick?: () => void;
  }): void;
}

export function detectNotificationSupport(
  win: Window = window,
): NotificationSupport {
  const nav = win.navigator;
  const notifications =
    typeof (win as { Notification?: unknown }).Notification !== "undefined" &&
    win.isSecureContext;
  // Electron exposes the Push API but has no push service behind it.
  const electron = /\bElectron\//u.test(nav.userAgent);
  if (
    notifications &&
    !electron &&
    "serviceWorker" in nav &&
    "PushManager" in win
  ) {
    return "push";
  }
  const ios =
    /iPad|iPhone|iPod/u.test(nav.userAgent) ||
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  const standalone =
    win.matchMedia?.("(display-mode: standalone)").matches === true ||
    (nav as { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return "install";
  return notifications ? "local" : "none";
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function sameBytes(left: ArrayBuffer | null | undefined, right: Uint8Array) {
  if (!left || left.byteLength !== right.length) return false;
  const view = new Uint8Array(left);
  return view.every((byte, index) => byte === right[index]);
}

/**
 * Register the notification service worker as a classic script (Safari
 * and Firefox do not all load module service workers).
 */
export async function registerAssistantServiceWorker(): Promise<
  ServiceWorkerRegistration | undefined
> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) {
    return undefined;
  }
  try {
    return await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  } catch {
    return undefined;
  }
}

export function createNotificationBrowser(): NotificationBrowser {
  const support =
    typeof window === "undefined" ? "none" : detectNotificationSupport();
  return {
    support,
    desktopApp:
      typeof navigator !== "undefined" &&
      /\bElectron\//u.test(navigator.userAgent),
    permission: () =>
      typeof Notification === "undefined"
        ? "unavailable"
        : Notification.permission,
    requestPermission: async () =>
      typeof Notification === "undefined"
        ? "unavailable"
        : Notification.requestPermission(),
    async currentSubscription() {
      const registration = await navigator.serviceWorker?.getRegistration();
      return (await registration?.pushManager?.getSubscription()) ?? null;
    },
    async subscribe(publicKey) {
      await registerAssistantServiceWorker();
      const registration = await navigator.serviceWorker.ready;
      const key = base64UrlToBytes(publicKey);
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        if (sameBytes(existing.options.applicationServerKey, key)) {
          return existing;
        }
        // Made with another server key: it cannot receive this server's.
        await existing.unsubscribe();
      }
      return registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
    },
    showLocal({ title, body, tag, onClick }) {
      try {
        const notification = new Notification(title, {
          ...(body ? { body } : {}),
          ...(tag ? { tag } : {}),
          icon: "/agentlink-icon.png",
        });
        notification.onclick = () => {
          // In the desktop app `window.focus()` cannot show its hidden
          // window or switch to the Assistant view; the desktop does both.
          window.agentlinkDesktopEmbed?.focus?.();
          window.focus();
          notification.close();
          onClick?.();
        };
      } catch {
        // Some browsers only allow notifications from a service worker.
      }
    },
  };
}

let defaultBrowser: NotificationBrowser | undefined;
function notificationBrowser(): NotificationBrowser {
  defaultBrowser ??= createNotificationBrowser();
  return defaultBrowser;
}

export function localNotificationsOn(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): boolean {
  try {
    return storage.getItem(LOCAL_NOTIFICATIONS_KEY) === "on";
  } catch {
    return false;
  }
}

function setLocalNotifications(
  on: boolean,
  storage: Pick<Storage, "setItem">,
): void {
  try {
    storage.setItem(LOCAL_NOTIFICATIONS_KEY, on ? "on" : "off");
  } catch {
    // A preference, not a requirement.
  }
}

/**
 * The chat a link like `/?openProject=…&openSession=…&inboxEntry=…` opens,
 * or the task `/?openTask=…&inboxEntry=…` opens.
 */
export function openTargetFromUrl(href: string): OpenTarget | null {
  let url: URL;
  try {
    url = new URL(href, "https://assistant.invalid");
  } catch {
    return null;
  }
  const projectId = url.searchParams.get("openProject") ?? undefined;
  const sessionId = url.searchParams.get("openSession") ?? undefined;
  const entryId = url.searchParams.get("inboxEntry") ?? undefined;
  const taskId = url.searchParams.get("openTask") ?? undefined;
  if (!entryId && !taskId && !(projectId && sessionId)) return null;
  return {
    ...(projectId && sessionId ? { projectId, sessionId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(entryId ? { entryId } : {}),
  };
}

/** The same URL without the open-chat parameters. */
export function withoutOpenTarget(href: string): string {
  const url = new URL(href);
  for (const name of ["openProject", "openSession", "openTask", "inboxEntry"]) {
    url.searchParams.delete(name);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Open the chats notifications link to: the link this page was opened
 * with, and clicks on notifications while it is open.
 */
export function useNotificationLinks(open: (target: OpenTarget) => void) {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    void registerAssistantServiceWorker();
    const initial = openTargetFromUrl(window.location.href);
    if (initial) {
      // Stripped first, so a reload into another project does not repeat it.
      window.history.replaceState(
        window.history.state,
        "",
        withoutOpenTarget(window.location.href),
      );
      openRef.current(initial);
    }
    const container = navigator.serviceWorker;
    if (!container) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (data?.type !== OPEN_URL_MESSAGE || typeof data.url !== "string") {
        return;
      }
      const target = openTargetFromUrl(data.url);
      if (target) openRef.current(target);
    };
    container.addEventListener("message", onMessage);
    return () => container.removeEventListener("message", onMessage);
  }, []);
}

/**
 * Without a push service, show new inbox entries while the Assistant is
 * open but not in front. The first fetch only records what is there.
 */
export function useLocalInboxNotifications(
  revision: number,
  open: (target: OpenTarget) => void,
  browser: NotificationBrowser = notificationBrowser(),
  storage: Pick<Storage, "getItem"> = window.localStorage,
) {
  const seen = useRef<Set<string> | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    // `push` too: a browser whose push service failed falls back to this.
    if (browser.support === "none" || browser.support === "install") return;
    if (!localNotificationsOn(storage) || browser.permission() !== "granted") {
      seen.current = null;
      return;
    }
    // Every result is used, even after a newer revision: a skipped first
    // result would make the next one the baseline and hide its entries.
    requestJson<{ entries: InboxEntryLike[] }>("/api/inbox").then(
      ({ entries }) => {
        if (!mounted.current) return;
        const baseline = seen.current === null;
        const known = (seen.current ??= new Set());
        const watching =
          document.visibilityState === "visible" && document.hasFocus();
        for (const entry of entries) {
          if (known.has(entry.id)) continue;
          known.add(entry.id);
          if (baseline || entry.read || watching) continue;
          browser.showLocal({
            title: entry.title,
            ...(entry.body ? { body: entry.body } : {}),
            tag: entry.id,
            onClick: () =>
              openRef.current({
                entryId: entry.id,
                ...(entry.sessionId
                  ? { projectId: entry.projectId, sessionId: entry.sessionId }
                  : {}),
                ...(entry.taskId ? { taskId: entry.taskId } : {}),
              }),
          });
        }
      },
      () => undefined,
    );
  }, [revision, browser, storage]);
}

type SettingsState = "loading" | "on" | "off";

const TEST_OUTCOMES: Record<string, string> = {
  sent: "Sent. It should arrive in a few seconds.",
  gone: "The push service no longer accepts this device. Turn notifications on again.",
  failed: "The push service did not accept the test. Try again later.",
};

export function NotificationSettings({
  browser = notificationBrowser(),
  storage = window.localStorage,
}: {
  browser?: NotificationBrowser;
  storage?: Pick<Storage, "getItem" | "setItem">;
}) {
  // A browser that fell back to local notifications stays on them until
  // they are turned off; then push can be tried again.
  const [support, setSupport] = useState<NotificationSupport>(() =>
    browser.support === "push" && localNotificationsOn(storage)
      ? "local"
      : browser.support,
  );
  const [state, setState] = useState<SettingsState>("loading");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const granted = () => browser.permission() === "granted";
    if (support === "push") {
      Promise.all([
        requestJson<{ subscribed: boolean }>("/api/push"),
        browser.currentSubscription(),
      ]).then(
        ([server, subscription]) => {
          if (cancelled) return;
          setState(
            server.subscribed && subscription && granted() ? "on" : "off",
          );
        },
        (caught: unknown) => {
          if (cancelled) return;
          setError(errorText(caught));
          setState("off");
        },
      );
    } else {
      setState(
        support === "local" && localNotificationsOn(storage) && granted()
          ? "on"
          : "off",
      );
    }
    return () => {
      cancelled = true;
    };
  }, [support, browser, storage]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await work();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const turnOn = () =>
    run(async () => {
      // Asked first, while this still counts as the click (Safari needs it).
      const permission = await browser.requestPermission();
      if (permission !== "granted") {
        setNote(
          browser.desktopApp
            ? "The AgentLink desktop app didn't allow notifications. Update the app to the latest version, then try again."
            : "Notifications are blocked for this site. Allow them in the browser's site settings, then try again.",
        );
        return;
      }
      if (support === "local") {
        setLocalNotifications(true, storage);
        setState("on");
        return;
      }
      const { publicKey } = await requestJson<{ publicKey: string }>(
        "/api/push",
      );
      let subscription: BrowserSubscription;
      try {
        subscription = await browser.subscribe(publicKey);
      } catch {
        // No push service behind the API: notify while the app is open.
        setLocalNotifications(true, storage);
        setSupport("local");
        setNote(
          "This browser cannot receive push notifications, so you will get them while the Assistant is open.",
        );
        return;
      }
      await requestJson("/api/push/subscription", {
        method: "PUT",
        body: subscription.toJSON(),
      });
      setState("on");
    });

  const turnOff = () =>
    run(async () => {
      if (support === "local") {
        setLocalNotifications(false, storage);
        setState("off");
        return;
      }
      const subscription = await browser.currentSubscription();
      await subscription?.unsubscribe().catch(() => false);
      await requestJson("/api/push/subscription", { method: "DELETE" });
      setState("off");
    });

  const sendTest = () =>
    run(async () => {
      if (support === "local") {
        browser.showLocal({
          title: "AgentLink Assistant",
          body: "Notifications are working on this device.",
          tag: "test",
        });
        setNote(TEST_OUTCOMES.sent!);
        return;
      }
      const result = await requestJson<{ outcome: string }>("/api/push/test", {
        method: "POST",
      });
      setNote(TEST_OUTCOMES[result.outcome] ?? TEST_OUTCOMES.failed!);
      if (result.outcome === "gone") setState("off");
    });

  return (
    <section class="assistant-notifications" aria-label="Notifications">
      <div class="assistant-notifications-row">
        <i
          class={`codicon codicon-${state === "on" ? "bell-dot" : "bell"}`}
          aria-hidden="true"
        />
        <span class="assistant-notifications-status">
          {support === "install"
            ? "Notifications need the Home Screen app"
            : support === "none"
              ? "This browser cannot show notifications"
              : state === "loading"
                ? "Notifications…"
                : state === "on"
                  ? support === "local"
                    ? "Notifications on while the Assistant is open"
                    : "Notifications on for this device"
                  : "Notifications off for this device"}
        </span>
        {(support === "push" || support === "local") && state !== "loading" && (
          <span class="assistant-notifications-actions">
            {state === "on" && (
              <button
                type="button"
                class="assistant-panel-action"
                disabled={busy}
                onClick={() => void sendTest()}
              >
                Send test
              </button>
            )}
            <button
              type="button"
              class="assistant-panel-action"
              disabled={busy}
              onClick={() => void (state === "on" ? turnOff() : turnOn())}
            >
              {state === "on" ? "Turn off" : "Turn on"}
            </button>
          </span>
        )}
      </div>
      {support === "install" && (
        <p class="assistant-project-hint">
          On iPhone and iPad, tap Share, then Add to Home Screen, and open the
          Assistant from the Home Screen to turn notifications on.
        </p>
      )}
      {note && (
        <p class="assistant-project-hint" role="status">
          {note}
        </p>
      )}
      {error && (
        <p class="assistant-project-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
