type NotificationClickEvent = Event & {
  notification: { close(): void; data?: unknown };
  waitUntil(promise: Promise<unknown>): void;
};

type PushEvent = Event & {
  data: { json(): unknown } | null;
  waitUntil(promise: Promise<unknown>): void;
};

type ServiceWorkerClient = {
  url: string;
  focus(): Promise<ServiceWorkerClient>;
  postMessage(message: unknown): void;
};

type NotificationWorkerScope = {
  location: Location;
  registration: {
    showNotification(
      title: string,
      options: NotificationOptions & { data?: unknown },
    ): Promise<void>;
  };
  clients: {
    matchAll(options: {
      type: "window";
      includeUncontrolled: boolean;
    }): Promise<ServiceWorkerClient[]>;
    openWindow(url: string): Promise<ServiceWorkerClient | null>;
  };
  addEventListener(
    type: "notificationclick",
    listener: (event: NotificationClickEvent) => void,
  ): void;
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
};

/**
 * Sent to an open page so it opens a notification's chat itself. Kept in
 * step with `OPEN_URL_MESSAGE` in AssistantNotifications.tsx; the worker
 * has no imports or exports so it also loads as a classic script.
 */
const OPEN_URL_MESSAGE = "agentlink-open-url";

const worker = globalThis as unknown as NotificationWorkerScope;

/** A same-origin path from a notification, or the app's start page. */
function samePath(value: unknown): string {
  if (typeof value !== "string") return "/";
  try {
    const url = new URL(value, worker.location.origin);
    if (url.origin !== worker.location.origin) return "/";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}

function text(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" && value.trim()
    ? value.slice(0, max)
    : fallback;
}

// Web Push from the AgentLink Assistant server. Every push shows a
// notification: browsers revoke subscriptions that stay silent.
worker.addEventListener("push", (event) => {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = event.data?.json();
    if (parsed && typeof parsed === "object") {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON: show the generic notification below.
  }
  event.waitUntil(
    worker.registration.showNotification(
      text(payload.title, "AgentLink Assistant", 200),
      {
        body: text(payload.body, "Something needs your attention.", 300),
        icon: "/agentlink-icon.png",
        badge: "/agentlink-icon.png",
        ...(typeof payload.tag === "string" ? { tag: payload.tag } : {}),
        data: { url: samePath(payload.url) },
      },
    ),
  );
});

worker.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: unknown } | undefined;
  const target = samePath(data?.url);
  event.waitUntil(
    worker.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        const existing = clients.find(
          (client) => new URL(client.url).origin === worker.location.origin,
        );
        if (existing) {
          if (target !== "/") {
            existing.postMessage({ type: OPEN_URL_MESSAGE, url: target });
          }
          await existing.focus();
          return;
        }
        await worker.clients.openWindow(target);
      }),
  );
});
