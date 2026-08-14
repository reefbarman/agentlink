type NotificationClickEvent = Event & {
  notification: { close(): void };
  waitUntil(promise: Promise<unknown>): void;
};

type ServiceWorkerClient = {
  url: string;
  focus(): Promise<ServiceWorkerClient>;
};

type NotificationWorkerScope = {
  location: Location;
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
};

const worker = globalThis as unknown as NotificationWorkerScope;

worker.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    worker.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        const existing = clients.find(
          (client) => new URL(client.url).origin === worker.location.origin,
        );
        if (existing) {
          await existing.focus();
          return;
        }
        await worker.clients.openWindow("/");
      }),
  );
});
