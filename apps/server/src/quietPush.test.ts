import { afterEach, describe, expect, it, vi } from "vitest";

import type { InboxEntry } from "./inboxStore.js";
import { defaultPersona, type PersonaSettings } from "./persona.js";
import type { PushMessage } from "./pushService.js";
import { createQuietPush } from "./quietPush.js";

afterEach(() => {
  vi.useRealTimers();
});

const BRISBANE = "Australia/Brisbane";
/** Friday 16 October 2026 at the given Brisbane time (UTC+10). */
const brisbane = (hours: number, minutes = 0) =>
  Date.UTC(2026, 9, 16, hours - 10, minutes);

const entry = (
  id: string,
  kind: InboxEntry["kind"] = "run_completed",
): InboxEntry =>
  ({
    id,
    kind,
    createdAt: 0,
    title: `Entry ${id}`,
    body: "",
    read: false,
  }) as InboxEntry;

const message = (id: string): PushMessage => ({
  title: `Entry ${id}`,
  body: "",
  url: `/?entry=${id}`,
  tag: id,
});

function setup(start: number, settings?: Partial<PersonaSettings>) {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  let current: PersonaSettings = { ...defaultPersona(BRISBANE), ...settings };
  const read = new Set<string>();
  const sent: PushMessage[] = [];
  const push = createQuietPush({
    settings: () => current,
    send: (pushMessage) => sent.push(pushMessage),
    isUnread: (id) => !read.has(id),
  });
  return {
    push,
    sent,
    read,
    change: (next: Partial<PersonaSettings>) => {
      current = { ...current, ...next };
      push.reschedule();
    },
  };
}

describe("quiet push", () => {
  it("sends straight away outside quiet hours", () => {
    const { push, sent } = setup(brisbane(12));
    push.deliver(entry("a"), message("a"));
    expect(sent).toEqual([message("a")]);
    expect(push.held()).toBe(0);
  });

  it("holds a notification until the quiet hours end, then sends it as itself", () => {
    const { push, sent } = setup(brisbane(23));
    push.deliver(entry("a"), message("a"));
    expect(sent).toEqual([]);
    expect(push.held()).toBe(1);
    vi.advanceTimersByTime(8 * 3_600_000 - 1_000);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(sent).toEqual([message("a")]);
    expect(push.held()).toBe(0);
  });

  it("sends several held notifications as one summary, leaving out read ones", () => {
    const { push, sent, read } = setup(brisbane(23));
    for (const id of ["a", "b", "c"]) push.deliver(entry(id), message(id));
    read.add("b");
    vi.advanceTimersByTime(8 * 3_600_000);
    expect(sent).toEqual([
      {
        title: "2 updates while it was quiet",
        body: "Entry a · Entry c",
        url: "/",
        tag: "quiet-hours",
      },
    ]);
  });

  it("sends nothing when everything held was read meanwhile", () => {
    const { push, sent, read } = setup(brisbane(23));
    push.deliver(entry("a"), message("a"));
    read.add("a");
    vi.advanceTimersByTime(8 * 3_600_000);
    expect(sent).toEqual([]);
  });

  it("lets approval requests through when allowed, and holds them when not", () => {
    const allowed = setup(brisbane(23));
    allowed.push.deliver(entry("a", "needs_approval"), message("a"));
    expect(allowed.sent).toEqual([message("a")]);

    const held = setup(brisbane(23), {
      quietHours: { start: "22:00", end: "07:00", allowApprovals: false },
    });
    held.push.deliver(entry("b", "needs_approval"), message("b"));
    expect(held.sent).toEqual([]);
  });

  it("sends what is held when quiet hours are turned off or moved", () => {
    const off = setup(brisbane(23));
    off.push.deliver(entry("a"), message("a"));
    off.change({ quietHours: undefined });
    expect(off.sent).toEqual([message("a")]);

    const moved = setup(brisbane(23));
    moved.push.deliver(entry("b"), message("b"));
    moved.change({
      quietHours: { start: "22:00", end: "23:30", allowApprovals: true },
    });
    expect(moved.sent).toEqual([]);
    vi.advanceTimersByTime(30 * 60_000);
    expect(moved.sent).toEqual([message("b")]);
  });

  it("drops what is held on close", () => {
    const { push, sent } = setup(brisbane(23));
    push.deliver(entry("a"), message("a"));
    push.close();
    vi.advanceTimersByTime(24 * 3_600_000);
    push.deliver(entry("b"), message("b"));
    expect(sent).toEqual([]);
    expect(push.held()).toBe(0);
  });
});
