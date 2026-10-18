import { WebFetchError, webFetchTarget } from "./webFetch.js";

/**
 * What a watch job watches: a page or feed, optionally one part of it, and
 * how often it may tell the owner per day. The job's prompt is the owner's
 * "what matters" note, and its schedule is how often it checks.
 */

/** Notifications per watch per day, by default; the rest wait for a briefing. */
export const DEFAULT_WATCH_NOTIFY_PER_DAY = 3;
export const MAX_WATCH_NOTIFY_PER_DAY = 24;
const MAX_SELECTOR_LENGTH = 200;
/** One compound selector: `tag`, `#id`, `.class`, or a mix (`div#main.post`). */
const SELECTOR_PATTERN = /^([a-z][a-z0-9-]*)?((?:[#.][a-z0-9_-]+)*)$/iu;

export interface WatchTarget {
  /** An `https://` page or RSS/Atom feed (`http://` is upgraded). */
  readonly url: string;
  /** Only the elements matching this selector; the main text when absent. */
  readonly selector?: string;
  readonly notifyPerDay: number;
}

/** What one watch check found, kept on its run record. */
export interface WatchRunRecord {
  /**
   * - `not_modified`: the site answered 304.
   * - `unchanged`: fetched, same text as last time.
   * - `baseline`: the first check, now remembered.
   * - `changed`: the text changed; a model turn judged it.
   * - `fetch_failed`: the page could not be read.
   */
  readonly outcome:
    | "not_modified"
    | "unchanged"
    | "baseline"
    | "changed"
    | "fetch_failed";
  /** The change matched what matters (changed runs, once judged). */
  readonly relevant?: boolean;
  /** The owner was told (Inbox entry and push). */
  readonly notified?: boolean;
  /** Relevant but over the day's cap: kept for the next briefing. */
  readonly heldForBriefing?: boolean;
}

export class WatchTargetError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WatchTargetError";
  }
}

/** A selector's parts, or undefined when it is not one we support. */
export function parseSelector(text: string):
  | {
      readonly tag?: string;
      readonly id?: string;
      readonly classes: readonly string[];
    }
  | undefined {
  const match = SELECTOR_PATTERN.exec(text.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  let id: string | undefined;
  const classes: string[] = [];
  for (const part of match[2]!.matchAll(/([#.])([a-z0-9_-]+)/giu)) {
    if (part[1] === "#") {
      if (id !== undefined) return undefined;
      id = part[2]!;
    } else {
      classes.push(part[2]!);
    }
  }
  return {
    ...(match[1] ? { tag: match[1].toLowerCase() } : {}),
    ...(id !== undefined ? { id } : {}),
    classes,
  };
}

/** Validate a watch target from an untrusted body. */
export function parseWatchTarget(value: unknown): WatchTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WatchTargetError("watch_invalid");
  }
  const body = value as Record<string, unknown>;
  const known = new Set(["url", "selector", "notifyPerDay"]);
  if (Object.keys(body).some((key) => !known.has(key))) {
    throw new WatchTargetError("watch_invalid");
  }
  if (typeof body.url !== "string" || body.url.length > 2_048) {
    throw new WatchTargetError("watch_url_invalid");
  }
  let url: string;
  try {
    url = webFetchTarget(body.url).href;
  } catch (error) {
    if (error instanceof WebFetchError) {
      throw new WatchTargetError("watch_url_invalid");
    }
    throw error;
  }
  let selector: string | undefined;
  if (body.selector !== undefined && body.selector !== "") {
    if (
      typeof body.selector !== "string" ||
      body.selector.length > MAX_SELECTOR_LENGTH ||
      !parseSelector(body.selector)
    ) {
      throw new WatchTargetError("watch_selector_invalid");
    }
    selector = body.selector.trim();
  }
  let notifyPerDay = DEFAULT_WATCH_NOTIFY_PER_DAY;
  if (body.notifyPerDay !== undefined) {
    if (
      typeof body.notifyPerDay !== "number" ||
      !Number.isInteger(body.notifyPerDay) ||
      body.notifyPerDay < 0 ||
      body.notifyPerDay > MAX_WATCH_NOTIFY_PER_DAY
    ) {
      throw new WatchTargetError("watch_notify_invalid");
    }
    notifyPerDay = body.notifyPerDay;
  }
  return { url, ...(selector ? { selector } : {}), notifyPerDay };
}
