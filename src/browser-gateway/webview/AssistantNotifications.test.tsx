// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssistantHub } from "./AssistantJobs";
import {
  LOCAL_NOTIFICATIONS_KEY,
  NotificationSettings,
  base64UrlToBytes,
  detectNotificationSupport,
  openTargetFromUrl,
  useLocalInboxNotifications,
  withoutOpenTarget,
  type NotificationBrowser,
  type NotificationSupport,
  type OpenTarget,
} from "./AssistantNotifications";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

type Route = (body: unknown) => unknown;

function stubFetch(routes: Record<string, Route>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url, body });
      const route = routes[`${method} ${url}`];
      if (!route) {
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
        });
      }
      return new Response(JSON.stringify(route(body)), { status: 200 });
    }),
  );
  return calls;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const SUBSCRIPTION_JSON = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  keys: { p256dh: "BPk", auth: "c2VjcmV0" },
};

function fakeBrowser(
  support: NotificationSupport,
  options: {
    permission?: NotificationPermission;
    grant?: NotificationPermission;
    subscribed?: boolean;
    subscribeFails?: boolean;
  } = {},
) {
  let permission: NotificationPermission = options.permission ?? "default";
  const unsubscribe = vi.fn(async () => true);
  const subscription = { toJSON: () => SUBSCRIPTION_JSON, unsubscribe };
  let current = options.subscribed ? subscription : null;
  const browser = {
    support,
    permission: () => permission,
    requestPermission: vi.fn(async () => {
      permission = options.grant ?? "granted";
      return permission;
    }),
    currentSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (_key: string) => {
      if (options.subscribeFails) throw new Error("push service not available");
      current = subscription;
      return subscription;
    }),
    showLocal: vi.fn<NotificationBrowser["showLocal"]>(),
  } satisfies NotificationBrowser;
  return { browser, unsubscribe };
}

function fakeWindow(options: {
  userAgent: string;
  notification?: boolean;
  push?: boolean;
  standalone?: boolean;
}): Window {
  return {
    isSecureContext: true,
    ...(options.notification === false ? {} : { Notification: function () {} }),
    ...(options.push ? { PushManager: function () {} } : {}),
    navigator: {
      userAgent: options.userAgent,
      platform: "",
      maxTouchPoints: 0,
      ...(options.push ? { serviceWorker: {} } : {}),
    },
    matchMedia: () => ({ matches: options.standalone === true }),
  } as unknown as Window;
}

describe("detectNotificationSupport", () => {
  it("tells push, local-only, Home Screen and unsupported browsers apart", () => {
    expect(
      detectNotificationSupport(
        fakeWindow({ userAgent: "Mozilla/5.0 Chrome/140", push: true }),
      ),
    ).toBe("push");
    // The desktop app's view has the API but no push service.
    expect(
      detectNotificationSupport(
        fakeWindow({
          userAgent: "Mozilla/5.0 Chrome/140 Electron/38.0.0",
          push: true,
        }),
      ),
    ).toBe("local");
    expect(
      detectNotificationSupport(
        fakeWindow({
          userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari",
          notification: false,
        }),
      ),
    ).toBe("install");
    expect(
      detectNotificationSupport(
        fakeWindow({
          userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari",
          push: true,
          standalone: true,
        }),
      ),
    ).toBe("push");
    expect(
      detectNotificationSupport(
        fakeWindow({ userAgent: "Mozilla/5.0", notification: false }),
      ),
    ).toBe("none");
  });
});

describe("notification links", () => {
  it("reads and strips the chat a notification opens", () => {
    expect(
      openTargetFromUrl("/?inboxEntry=e1&openProject=home&openSession=s1"),
    ).toEqual({ projectId: "home", sessionId: "s1", entryId: "e1" });
    expect(openTargetFromUrl("/?inboxEntry=e1")).toEqual({ entryId: "e1" });
    expect(openTargetFromUrl("/?inboxEntry=e1&openTask=t1")).toEqual({
      taskId: "t1",
      entryId: "e1",
    });
    expect(openTargetFromUrl("/?openProject=home")).toBeNull();
    expect(openTargetFromUrl("/")).toBeNull();
    expect(
      withoutOpenTarget(
        "https://a.local/?keep=1&inboxEntry=e1&openProject=p&openSession=s&openTask=t#x",
      ),
    ).toBe("/?keep=1#x");
  });

  it("decodes the server's base64url VAPID key", () => {
    expect([...base64UrlToBytes("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
  });
});

describe("NotificationSettings", () => {
  it("turns push on, sends a test and turns it off for this device", async () => {
    const calls = stubFetch({
      "GET /api/push": () => ({ publicKey: "BPub", subscribed: false }),
      "PUT /api/push/subscription": () => ({ subscribed: true }),
      "POST /api/push/test": () => ({ outcome: "sent", status: 201 }),
      "DELETE /api/push/subscription": () => ({ subscribed: false }),
    });
    const { browser, unsubscribe } = fakeBrowser("push");
    render(
      <NotificationSettings browser={browser} storage={memoryStorage()} />,
    );
    await screen.findByText("Notifications off for this device");

    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await screen.findByText("Notifications on for this device");
    expect(browser.requestPermission).toHaveBeenCalledOnce();
    expect(browser.subscribe).toHaveBeenCalledWith("BPub");
    expect(calls).toContainEqual({
      method: "PUT",
      path: "/api/push/subscription",
      body: SUBSCRIPTION_JSON,
    });

    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await screen.findByText("Sent. It should arrive in a few seconds.");

    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await screen.findByText("Notifications off for this device");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/api/push/subscription",
    });
  });

  it("shows on only when both the server and this browser are subscribed", async () => {
    stubFetch({
      "GET /api/push": () => ({ publicKey: "BPub", subscribed: true }),
    });
    const on = fakeBrowser("push", { permission: "granted", subscribed: true });
    render(
      <NotificationSettings browser={on.browser} storage={memoryStorage()} />,
    );
    await screen.findByText("Notifications on for this device");
    cleanup();

    const browserLost = fakeBrowser("push", { permission: "granted" });
    render(
      <NotificationSettings
        browser={browserLost.browser}
        storage={memoryStorage()}
      />,
    );
    await screen.findByText("Notifications off for this device");
  });

  it("explains a blocked permission without subscribing", async () => {
    stubFetch({
      "GET /api/push": () => ({ publicKey: "BPub", subscribed: false }),
    });
    const { browser } = fakeBrowser("push", { grant: "denied" });
    render(
      <NotificationSettings browser={browser} storage={memoryStorage()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    await screen.findByText(/Notifications are blocked for this site/u);
    expect(browser.subscribe).not.toHaveBeenCalled();
  });

  it("falls back to notifying while open when the browser has no push service", async () => {
    const calls = stubFetch({
      "GET /api/push": () => ({ publicKey: "BPub", subscribed: false }),
    });
    const storage = memoryStorage();
    const { browser } = fakeBrowser("push", { subscribeFails: true });
    render(<NotificationSettings browser={browser} storage={storage} />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    await screen.findByText(/cannot receive push notifications/u);
    expect(storage.values.get(LOCAL_NOTIFICATIONS_KEY)).toBe("on");
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    await screen.findByText("Notifications on while the Assistant is open");
  });

  it("uses local notifications in the desktop app", async () => {
    const calls = stubFetch({});
    const storage = memoryStorage();
    const { browser } = fakeBrowser("local");
    render(<NotificationSettings browser={browser} storage={storage} />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    await screen.findByText("Notifications on while the Assistant is open");
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() =>
      expect(browser.showLocal).toHaveBeenCalledWith(
        expect.objectContaining({ title: "AgentLink Assistant" }),
      ),
    );
    expect(calls).toEqual([]);
    expect(storage.values.get(LOCAL_NOTIFICATIONS_KEY)).toBe("on");
  });

  it("tells iPhone users to add the Assistant to the Home Screen", () => {
    stubFetch({});
    const { browser } = fakeBrowser("install");
    render(
      <NotificationSettings browser={browser} storage={memoryStorage()} />,
    );
    expect(
      screen.getByText("Notifications need the Home Screen app"),
    ).toBeTruthy();
    expect(screen.getByText(/Add to Home Screen/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
  });
});

describe("useLocalInboxNotifications", () => {
  function Probe(props: {
    revision: number;
    open: (target: OpenTarget) => void;
    browser: NotificationBrowser;
    storage: Pick<Storage, "getItem">;
  }) {
    useLocalInboxNotifications(
      props.revision,
      props.open,
      props.browser,
      props.storage,
    );
    return null;
  }

  it("shows entries that arrive after the page loaded, in the background", async () => {
    let entries = [
      {
        id: "old",
        title: "Old",
        projectId: "home",
        sessionId: "s0",
        read: false,
      },
    ];
    stubFetch({ "GET /api/inbox": () => ({ entries }) });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { browser } = fakeBrowser("local", { permission: "granted" });
    const storage = memoryStorage({ [LOCAL_NOTIFICATIONS_KEY]: "on" });
    const open = vi.fn();
    const view = render(
      <Probe revision={1} open={open} browser={browser} storage={storage} />,
    );
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    expect(browser.showLocal).not.toHaveBeenCalled();

    entries = [
      {
        id: "new",
        title: "Morning brief finished",
        projectId: "work",
        sessionId: "s1",
        read: false,
      },
      ...entries,
    ];
    view.rerender(
      <Probe revision={2} open={open} browser={browser} storage={storage} />,
    );
    await waitFor(() => expect(browser.showLocal).toHaveBeenCalledOnce());
    const shown = browser.showLocal.mock.calls[0]![0];
    expect(shown).toMatchObject({
      title: "Morning brief finished",
      tag: "new",
    });
    shown.onClick?.();
    expect(open).toHaveBeenCalledWith({
      entryId: "new",
      projectId: "work",
      sessionId: "s1",
    });
  });

  it("stays quiet when local notifications are off", async () => {
    const calls = stubFetch({ "GET /api/inbox": () => ({ entries: [] }) });
    const { browser } = fakeBrowser("local", { permission: "granted" });
    render(
      <Probe
        revision={1}
        open={vi.fn()}
        browser={browser}
        storage={memoryStorage()}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual([]);
  });
});

describe("AssistantHub notification links", () => {
  it("opens the chat a notification linked to and marks its entry read", async () => {
    window.history.replaceState(
      null,
      "",
      "/?inboxEntry=e1&openProject=work&openSession=s9",
    );
    const calls = stubFetch({
      "POST /api/inbox/read": () => ({ ok: true, marked: 1, unread: 0 }),
      "GET /api/ask-agent/projects": () => ({ activeProjectId: "home" }),
      "POST /api/ask-agent/projects/select": () => ({ ok: true }),
    });
    const reloadPage = vi.fn();
    const loadSession = vi.fn();
    render(<AssistantHub loadSession={loadSession} reloadPage={reloadPage} />);
    // Stripped before anything else, so the reload does not repeat it.
    expect(window.location.search).toBe("");
    await waitFor(() => expect(reloadPage).toHaveBeenCalledOnce());
    // The hub's independent setup-status read is not part of the link flow.
    const linkCalls = calls.filter((call) => call.path !== "/api/onboarding");
    expect(linkCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/inbox/read",
      "GET /api/ask-agent/projects",
      "POST /api/ask-agent/projects/select",
    ]);
    expect(linkCalls[0]!.body).toEqual({ ids: ["e1"] });
    expect(linkCalls[2]!.body).toEqual({ projectId: "work", sessionId: "s9" });
    expect(loadSession).not.toHaveBeenCalled();
  });
});
