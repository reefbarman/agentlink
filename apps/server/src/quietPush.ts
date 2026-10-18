import type { InboxEntry } from "./inboxStore.js";
import {
  isQuietTime,
  untilQuietEnds,
  type PersonaSettings,
} from "./persona.js";
import type { PushMessage } from "./pushService.js";

/**
 * Quiet hours for push notifications. Inbox entries are always recorded;
 * only the push waits. During quiet hours a notification is held, except
 * an approval request when the owner lets those through. When the quiet
 * hours end, the held entries still unread are sent: one as itself, more
 * as one summary. Held notifications live in memory only: a restart
 * during quiet hours drops their push, never their Inbox entries.
 */

export interface QuietPush {
  /** Push now, or hold it until the quiet hours end. */
  deliver(entry: InboxEntry, message: PushMessage): void;
  /** Settings changed: send now if no longer quiet, or re-time the wait. */
  reschedule(): void;
  /** How many are held, for status and tests. */
  held(): number;
  close(): void;
}

export function createQuietPush(options: {
  readonly settings: () => PersonaSettings;
  readonly send: (message: PushMessage) => void;
  /** Whether the entry is still unread (read ones are not pushed later). */
  readonly isUnread: (entryId: string) => boolean;
  readonly now?: () => number;
}): QuietPush {
  const now = options.now ?? Date.now;
  let waiting: Array<{ entry: InboxEntry; message: PushMessage }> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const quiet = () => {
    const settings = options.settings();
    return isQuietTime(settings.quietHours, settings.timeZone, now());
  };

  const flush = () => {
    const unread = waiting.filter(({ entry }) => options.isUnread(entry.id));
    waiting = [];
    if (unread.length === 1) options.send(unread[0]!.message);
    else if (unread.length > 1) {
      options.send({
        title: `${unread.length} updates while it was quiet`,
        body: unread
          .slice(0, 3)
          .map(({ entry }) => entry.title)
          .join(" · ")
          .slice(0, 200),
        url: "/",
        tag: "quiet-hours",
      });
    }
  };

  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (closed || waiting.length === 0) return;
    const settings = options.settings();
    if (!settings.quietHours || !quiet()) {
      flush();
      return;
    }
    timer = setTimeout(
      arm,
      untilQuietEnds(settings.quietHours, settings.timeZone, now()),
    );
    timer.unref?.();
  };

  return {
    deliver(entry, message) {
      if (closed) return;
      const settings = options.settings();
      const approval =
        entry.kind === "needs_approval" &&
        settings.quietHours?.allowApprovals === true;
      if (approval || !quiet()) {
        options.send(message);
        return;
      }
      waiting.push({ entry, message });
      if (!timer) arm();
    },
    reschedule: arm,
    held: () => waiting.length,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      waiting = [];
    },
  };
}
