import { promises as fs } from "node:fs";
import https from "node:https";
import path from "node:path";
import tls from "node:tls";

import { writeFileAtomic } from "./atomicFile.js";
import type { InboxEntry } from "./inboxStore.js";
import { normalizeHostname, parseEgressAllowlist } from "./egressGateway.js";
import type { NetworkPolicy } from "./egressPolicy.js";
import type { WebConnector } from "./webFetch.js";
import {
  checkSubscriptionKeys,
  checkVapidKeys,
  encryptPushMessage,
  generateVapidKeys,
  vapidAuthorization,
  type VapidKeys,
} from "./webPush.js";

/**
 * Web Push for the Assistant: one subscription per signed-in device, kept
 * in `<dataRoot>/push/subscriptions.json`, and the server's VAPID keys in
 * `<dataRoot>/push/vapid.json` (created on first start, owner-only).
 *
 * Delivery is best effort: the inbox is the record, so a failed push is
 * logged and never fails the work that raised it. Subscriptions may only
 * point at the browsers' push services, which are also the only hosts the
 * sending connection is allowed to reach.
 */

/** Chrome and Edge on Android (FCM), Firefox, Safari/iOS, Edge on Windows. */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "*.push.apple.com",
  "*.notify.windows.com",
];

/** Only the push services, never the project's sites. */
export const PUSH_NETWORK_POLICY: NetworkPolicy = {
  preset: "dependencies",
  allow: PUSH_SERVICE_HOSTS,
};

export const DEFAULT_PUSH_SUBJECT = "https://github.com/reefbarman/agentlink";
const MAX_SUBSCRIPTIONS = 50;
const MAX_ENDPOINT_LENGTH = 2_048;
const DEFAULT_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2_000, 10_000];
const MAX_RETRY_AFTER_MS = 60_000;
const SEND_TIMEOUT_MS = 15_000;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

const pushServices = parseEgressAllowlist(PUSH_SERVICE_HOSTS);

export interface PushSubscriptionInput {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

export interface StoredPushSubscription extends PushSubscriptionInput {
  readonly deviceId: string;
  readonly createdAt: number;
}

/** What the service worker shows. Keep it short: nothing sensitive. */
export interface PushMessage {
  readonly title: string;
  readonly body?: string;
  /** Same-origin path the notification opens. */
  readonly url: string;
  /** Replaces an earlier notification with the same tag. */
  readonly tag?: string;
  readonly urgency?: "normal" | "high";
  readonly ttlSeconds?: number;
}

export interface PushDelivery {
  readonly deviceId: string;
  /** `gone`: the push service dropped the subscription, so it was removed. */
  readonly outcome: "sent" | "gone" | "failed";
  readonly status?: number;
}

export interface PushRequest {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly signal: AbortSignal;
}

export interface PushResponse {
  readonly status: number;
  /** From `Retry-After`, in seconds. */
  readonly retryAfterSeconds?: number;
}

export type PushTransport = (request: PushRequest) => Promise<PushResponse>;

export class PushSubscriptionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface PushService {
  /** The VAPID public key browsers subscribe with. */
  readonly publicKey: string;
  isSubscribed(deviceId: string): boolean;
  /**
   * Replace this device's subscription with a browser's `PushSubscription`
   * JSON. Throws `PushSubscriptionError` when it is not usable.
   */
  subscribe(deviceId: string, input: unknown, now: number): Promise<void>;
  unsubscribe(deviceId: string): Promise<boolean>;
  /** Drop subscriptions of devices that are no longer signed in. */
  retainDevices(active: ReadonlySet<string>): Promise<number>;
  notifyAll(message: PushMessage): Promise<readonly PushDelivery[]>;
  notifyDevice(
    deviceId: string,
    message: PushMessage,
  ): Promise<PushDelivery | undefined>;
  /** Abort deliveries still retrying and wait for writes. */
  close(): Promise<void>;
}

export interface OpenPushServiceOptions {
  readonly directory: string;
  readonly transport: PushTransport;
  /** VAPID `sub`: `mailto:` or `https:`. */
  readonly subject?: string;
  /** Devices still signed in; others are dropped before sending. */
  readonly activeDevices?: () => ReadonlySet<string> | undefined;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly attempts?: number;
}

interface StoredSubscriptions {
  readonly schemaVersion: 1;
  readonly subscriptions: readonly StoredPushSubscription[];
}

interface StoredKeys extends VapidKeys {
  readonly schemaVersion: 1;
  readonly createdAt: number;
}

const ENTRY_DESCRIPTIONS: Readonly<Record<InboxEntry["kind"], string>> = {
  run_completed: "Finished. Open the chat to see the result.",
  run_failed: "Failed. Open the chat to see what happened.",
  run_blocked: "Blocked. It needs you to sign in again or wait for limits.",
  needs_approval: "Waiting for your approval.",
  task_published:
    "Its draft pull request is open. Open it to see the evidence.",
  task_ready: "Ready, but not published. Open it to see why.",
  task_blocked: "Blocked. Open it to see what it needs.",
  task_failed: "Failed. Open it to see what happened.",
  session_long_running:
    "Still working. Open it to check in, or stop it from the Inbox.",
  session_stuck:
    "It may be stuck. Open the Inbox to stop it or let it keep going.",
  backup_failed: "Backups need attention. Open the Inbox to see why.",
  restored: "Restored from a backup. Scheduled jobs are paused.",
  chat_interrupted: "Stopped for an upgrade. Open the chat to carry on.",
  audit_checkpoint: "The audit log needs attention. Open the Inbox to see why.",
  mcp_changed: "MCP tools changed and ask again. Open the Inbox to see which.",
  watch_changed: "Something you watch changed. Open it to see what.",
  briefing: "Your briefing is ready. Open it to read it.",
  job_noisy: "A job or watch is busier than usual. Open the Inbox to see it.",
};

/**
 * The same-origin link that opens an entry's task, or its chat (and marks
 * it read).
 */
export function inboxEntryUrl(entry: InboxEntry): string {
  const query = new URLSearchParams({ inboxEntry: entry.id });
  if (entry.taskId) {
    query.set("openTask", entry.taskId);
  } else if (entry.sessionId) {
    query.set("openProject", entry.projectId);
    query.set("openSession", entry.sessionId);
  }
  return `/?${query.toString()}`;
}

/**
 * The notification for an inbox entry: its title and a fixed description,
 * or with `includeSummary` the entry's one-line summary (the run's reply),
 * which then passes through the push service, encrypted.
 */
export function pushMessageForEntry(
  entry: InboxEntry,
  options: { readonly includeSummary?: boolean } = {},
): PushMessage {
  const summary = options.includeSummary
    ? entry.body?.split("\n").find((line) => line.trim())
    : undefined;
  return {
    title: entry.title,
    body: truncate(summary?.trim() || ENTRY_DESCRIPTIONS[entry.kind], 200),
    url: inboxEntryUrl(entry),
    tag: entry.runId
      ? `run:${entry.runId}`
      : entry.taskId
        ? `task:${entry.taskId}`
        : entry.sessionId
          ? `session:${entry.projectId}:${entry.sessionId}`
          : entry.id,
    ...(entry.kind === "needs_approval"
      ? { urgency: "high" as const, ttlSeconds: 12 * 60 * 60 }
      : {}),
  };
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

/** Validate a subscription a browser sent. Throws `PushSubscriptionError`. */
export function checkPushSubscription(input: unknown): PushSubscriptionInput {
  if (!input || typeof input !== "object") {
    throw new PushSubscriptionError("push_subscription_invalid");
  }
  const value = input as Record<string, unknown>;
  const keys = value.keys as Record<string, unknown> | undefined;
  if (
    typeof value.endpoint !== "string" ||
    value.endpoint.length > MAX_ENDPOINT_LENGTH ||
    !keys ||
    typeof keys.p256dh !== "string" ||
    typeof keys.auth !== "string"
  ) {
    throw new PushSubscriptionError("push_subscription_invalid");
  }
  let url: URL;
  try {
    url = new URL(value.endpoint);
  } catch {
    throw new PushSubscriptionError("push_subscription_invalid");
  }
  const hostname = normalizeHostname(url.hostname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !hostname ||
    !pushServices.matches(hostname)
  ) {
    throw new PushSubscriptionError("push_endpoint_not_allowed");
  }
  const subscriptionKeys = { p256dh: keys.p256dh, auth: keys.auth };
  try {
    checkSubscriptionKeys(subscriptionKeys);
  } catch {
    throw new PushSubscriptionError("push_subscription_invalid");
  }
  return { endpoint: url.href, keys: subscriptionKeys };
}

export async function openPushService(
  options: OpenPushServiceOptions,
): Promise<PushService> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const subject = options.subject ?? DEFAULT_PUSH_SUBJECT;
  const keysFile = path.join(options.directory, "vapid.json");
  const subscriptionsFile = path.join(options.directory, "subscriptions.json");
  await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });

  let subscriptions: StoredPushSubscription[];
  let keys = await readKeys(keysFile);
  if (keys) {
    subscriptions = await readSubscriptions(subscriptionsFile);
  } else {
    // New keys: subscriptions made with any earlier keys cannot be used.
    const generated = generateVapidKeys();
    await writeFileAtomic(
      keysFile,
      `${JSON.stringify({ schemaVersion: 1, createdAt: now(), ...generated } satisfies StoredKeys)}\n`,
    );
    keys = generated;
    subscriptions = [];
    await fs.rm(subscriptionsFile, { force: true });
  }
  const vapid = keys;

  let writes: Promise<void> = Promise.resolve();
  const persist = () => {
    const content: StoredSubscriptions = { schemaVersion: 1, subscriptions };
    const next = writes.then(() =>
      writeFileAtomic(subscriptionsFile, `${JSON.stringify(content)}\n`),
    );
    writes = next.catch(() => undefined);
    return next;
  };

  const closing = new AbortController();
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work)).catch(() => undefined);
    return work;
  };

  const remove = async (
    matches: (subscription: StoredPushSubscription) => boolean,
  ) => {
    const kept = subscriptions.filter((item) => !matches(item));
    const removed = subscriptions.length - kept.length;
    if (removed > 0) {
      subscriptions = kept;
      await persist();
    }
    return removed;
  };

  const retainActive = async () => {
    const active = options.activeDevices?.();
    if (active) await remove((item) => !active.has(item.deviceId));
  };

  const deliver = async (
    subscription: StoredPushSubscription,
    message: PushMessage,
  ): Promise<PushDelivery> => {
    const payload = Buffer.from(
      JSON.stringify({
        title: message.title,
        ...(message.body ? { body: message.body } : {}),
        url: message.url,
        ...(message.tag ? { tag: message.tag } : {}),
      }),
    );
    const url = new URL(subscription.endpoint);
    let status: number | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (closing.signal.aborted) break;
      let retryAfterMs: number | undefined;
      try {
        const response = await options.transport({
          url,
          headers: {
            authorization: vapidAuthorization({
              endpoint: subscription.endpoint,
              keys: vapid,
              subject,
              now: now(),
            }),
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: String(message.ttlSeconds ?? DEFAULT_TTL_SECONDS),
            urgency: message.urgency ?? "normal",
          },
          // Fresh key and salt for every attempt.
          body: encryptPushMessage({
            ...subscription.keys,
            plaintext: payload,
          }),
          signal: AbortSignal.any([
            closing.signal,
            AbortSignal.timeout(SEND_TIMEOUT_MS),
          ]),
        });
        status = response.status;
        if (status >= 200 && status < 300) {
          return { deviceId: subscription.deviceId, outcome: "sent", status };
        }
        if (status === 404 || status === 410) {
          await remove((item) => item.endpoint === subscription.endpoint);
          log(
            `Push: the push service dropped a device's subscription (${status}); notifications are off on that device`,
          );
          return { deviceId: subscription.deviceId, outcome: "gone", status };
        }
        if (status !== 429 && status < 500) break;
        if (response.retryAfterSeconds !== undefined) {
          retryAfterMs = Math.min(
            response.retryAfterSeconds * 1000,
            MAX_RETRY_AFTER_MS,
          );
        }
      } catch (error) {
        status = undefined;
        if (closing.signal.aborted) break;
        if (attempt === attempts) {
          log(`Push: could not reach ${url.hostname}: ${describe(error)}`);
        }
      }
      if (attempt < attempts) {
        await sleep(
          retryAfterMs ??
            RETRY_DELAYS_MS[attempt - 1] ??
            RETRY_DELAYS_MS.at(-1)!,
          closing.signal,
        ).catch(() => undefined);
      }
    }
    if (status !== undefined) {
      log(`Push: ${url.hostname} refused a notification (${status})`);
    }
    return {
      deviceId: subscription.deviceId,
      outcome: "failed",
      ...(status === undefined ? {} : { status }),
    };
  };

  return {
    publicKey: vapid.publicKey,
    isSubscribed: (deviceId) =>
      subscriptions.some((item) => item.deviceId === deviceId),
    async subscribe(deviceId, input, at) {
      const checked = checkPushSubscription(input);
      const others = subscriptions.filter(
        (item) =>
          item.deviceId !== deviceId && item.endpoint !== checked.endpoint,
      );
      if (others.length >= MAX_SUBSCRIPTIONS) {
        throw new PushSubscriptionError("push_subscription_limit");
      }
      subscriptions = [...others, { ...checked, deviceId, createdAt: at }];
      await persist();
    },
    async unsubscribe(deviceId) {
      return (await remove((item) => item.deviceId === deviceId)) > 0;
    },
    retainDevices(active) {
      return remove((item) => !active.has(item.deviceId));
    },
    notifyAll(message) {
      return track(
        (async () => {
          await retainActive();
          return Promise.all(
            subscriptions.map((subscription) => deliver(subscription, message)),
          );
        })(),
      );
    },
    notifyDevice(deviceId, message) {
      return track(
        (async () => {
          await retainActive();
          const subscription = subscriptions.find(
            (item) => item.deviceId === deviceId,
          );
          return subscription ? deliver(subscription, message) : undefined;
        })(),
      );
    },
    async close() {
      closing.abort();
      await Promise.allSettled(inFlight);
      await writes;
    },
  };
}

/** Unreadable or mismatched keys are replaced, which drops subscriptions. */
async function readKeys(file: string): Promise<VapidKeys | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredKeys>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.publicKey !== "string" ||
      typeof parsed.privateKey !== "string"
    ) {
      return undefined;
    }
    const keys = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
    checkVapidKeys(keys);
    return keys;
  } catch {
    return undefined;
  }
}

/** An unreadable file starts empty: devices can turn notifications on again. */
async function readSubscriptions(
  file: string,
): Promise<StoredPushSubscription[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSubscriptions>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.subscriptions)) {
      return [];
    }
    return parsed.subscriptions.flatMap((item: StoredPushSubscription) => {
      try {
        if (
          typeof item.deviceId !== "string" ||
          typeof item.createdAt !== "number"
        ) {
          return [];
        }
        return [
          {
            ...checkPushSubscription(item),
            deviceId: item.deviceId,
            createdAt: item.createdAt,
          },
        ];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Send push requests over a policy-checked connection: through the egress
 * gateway when there is one, so only the push services can be reached.
 */
export function connectorPushTransport(
  connector: WebConnector,
  policy: NetworkPolicy = PUSH_NETWORK_POLICY,
): PushTransport {
  return async ({ url, headers, body, signal }) => {
    const hostname = url.hostname.toLowerCase();
    const raw = await connector.connect({
      hostname,
      port: 443,
      policy,
      signal,
    });
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const socket = tls.connect({
        socket: raw,
        servername: hostname,
        ALPNProtocols: ["http/1.1"],
      });
      socket.once("secureConnect", () => resolve(socket));
      socket.once("error", (error) => {
        raw.destroy();
        reject(error);
      });
    });
    return await new Promise<PushResponse>((resolve, reject) => {
      const request = https.request({
        hostname,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        // No `agent`: with `agent: false` Node ignores `createConnection`
        // and connects by itself, bypassing the checked connection.
        signal,
        createConnection: () => secure,
        headers: { ...headers, "content-length": String(body.length) },
      });
      request.once("response", (response) => {
        const retryAfter = Number(response.headers["retry-after"]);
        // The body is not needed; drain it so the socket can close.
        response.resume();
        response.once("end", () => secure.destroy());
        resolve({
          status: response.statusCode ?? 0,
          ...(Number.isFinite(retryAfter) && retryAfter >= 0
            ? { retryAfterSeconds: retryAfter }
            : {}),
        });
      });
      request.once("error", (error) => {
        secure.destroy();
        reject(error);
      });
      request.end(body);
    });
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
