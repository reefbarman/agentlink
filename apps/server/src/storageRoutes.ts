import { HttpError, sendJson } from "./httpJson.js";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AssistantServerAuth } from "./assistantServer.js";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Owner-only `GET /api/settings/storage`: how much each area of the data
 * root (and the projects folder) uses, and how long each kind of record is
 * kept. Sizes are measured on request; a walk that would visit more than
 * `maxEntries` files and folders stops there and says so (`partial`).
 */

const PATH = "/api/settings/storage";
const DEFAULT_MAX_ENTRIES = 200_000;

export interface StorageArea {
  readonly id: string;
  readonly label: string;
  readonly bytes: number;
  readonly files: number;
  /** The walk stopped early: the real size is larger. */
  readonly partial?: true;
}

export interface StorageRetention {
  readonly label: string;
  readonly text: string;
}

export interface StorageReport {
  readonly areas: readonly StorageArea[];
  readonly retention: readonly StorageRetention[];
  readonly measuredAt: number;
}

/** Areas of the data root, by folder. Anything else counts as "Other". */
const DATA_AREAS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly folders: readonly string[];
}> = [
  { id: "chats", label: "Chats", folders: ["workspace"] },
  {
    id: "tasks",
    label: "Coding tasks",
    folders: ["tasks", "runners", "runner-sessions", "repository-snapshots"],
  },
  { id: "events", label: "Live chat events", folders: ["events"] },
  { id: "memory", label: "Memory", folders: ["memory"] },
  { id: "inbox", label: "Inbox", folders: ["inbox"] },
  { id: "jobs", label: "Scheduled jobs", folders: ["jobs"] },
  { id: "audit", label: "Audit log", folders: ["audit"] },
];

/** How long each kind of record is kept; shown as written. */
export const STORAGE_RETENTION: readonly StorageRetention[] = [
  {
    label: "Chats",
    text: "Kept until you delete them. Deleting a chat removes its messages, background agents, commands, live events and Inbox entries.",
  },
  {
    label: "Coding tasks",
    text: "Kept until you delete the task, which removes its folder, its chats and their events.",
  },
  {
    label: "Live chat events",
    text: "The latest 1,000 per chat, for reconnecting; removed with the chat.",
  },
  { label: "Inbox", text: "The latest 500 entries." },
  { label: "Memory", text: "Kept until you forget it." },
  {
    label: "Audit log",
    text: "Kept for good. It records what happened and when, with IDs and hashes of any text, never the text itself.",
  },
  {
    label: "Backups",
    text: "Backups still contain deleted chats and memories until they are pruned: 48 hourly, 14 daily and 8 weekly copies are kept, so up to about 8 weeks.",
  },
];

export async function measureStorage(options: {
  readonly dataRoot: string;
  /** Project folders (`projectsRoot`, or each configured project's root). */
  readonly projectRoots: readonly string[];
  readonly maxEntries?: number;
  readonly now?: () => number;
}): Promise<StorageReport> {
  const budget = { left: options.maxEntries ?? DEFAULT_MAX_ENTRIES };
  const areas: StorageArea[] = [];
  const known = new Set<string>();
  for (const area of DATA_AREAS) {
    const total = emptyTotal();
    for (const folder of area.folders) {
      known.add(folder);
      add(total, await measure(path.join(options.dataRoot, folder), budget));
    }
    areas.push(toArea(area.id, area.label, total));
  }
  // Settings, credentials, push, TLS and anything newer.
  const other = emptyTotal();
  const entries = await fs
    .readdir(options.dataRoot, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    if (known.has(entry.name)) continue;
    add(other, await measure(path.join(options.dataRoot, entry.name), budget));
  }
  areas.push(toArea("other", "Settings and keys", other));
  const projects = emptyTotal();
  for (const root of new Set(options.projectRoots)) {
    add(projects, await measure(root, budget));
  }
  areas.push(toArea("projects", "Project folders", projects));
  return {
    areas,
    retention: STORAGE_RETENTION,
    measuredAt: (options.now ?? Date.now)(),
  };
}

export function createStorageRoutes(options: {
  readonly isOwner: (auth: AssistantServerAuth) => boolean;
  readonly measure: () => Promise<StorageReport>;
}): {
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean>;
} {
  // One walk at a time: a second request shares the running one.
  let running: Promise<StorageReport> | undefined;
  return {
    async handleRequest(request, response, auth) {
      const url = new URL(request.url ?? "/", "https://server.invalid");
      if (url.pathname !== PATH) return false;
      if (!options.isOwner(auth)) {
        throw new HttpError(403, "settings_forbidden");
      }
      if ((request.method ?? "GET").toUpperCase() !== "GET") {
        throw new HttpError(405, "method_not_allowed");
      }
      running ??= options.measure().finally(() => {
        running = undefined;
      });
      sendJson(response, 200, await running);
      return true;
    },
  };
}

interface Total {
  bytes: number;
  files: number;
  partial: boolean;
}

const emptyTotal = (): Total => ({ bytes: 0, files: 0, partial: false });

function add(total: Total, more: Total): void {
  total.bytes += more.bytes;
  total.files += more.files;
  total.partial ||= more.partial;
}

function toArea(id: string, label: string, total: Total): StorageArea {
  return {
    id,
    label,
    bytes: total.bytes,
    files: total.files,
    ...(total.partial ? { partial: true as const } : {}),
  };
}

/** Bytes and files under a path, without following symbolic links. */
async function measure(
  target: string,
  budget: { left: number },
): Promise<Total> {
  const total = emptyTotal();
  const pending = [target];
  while (pending.length > 0) {
    if (budget.left <= 0) {
      total.partial = true;
      break;
    }
    budget.left -= 1;
    const current = pending.pop()!;
    const stat = await fs.lstat(current).catch(() => undefined);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const names = await fs.readdir(current).catch(() => []);
      for (const name of names) pending.push(path.join(current, name));
    } else if (stat.isFile()) {
      total.bytes += stat.size;
      total.files += 1;
    }
  }
  return total;
}
