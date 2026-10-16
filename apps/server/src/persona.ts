import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomicFile.js";

/**
 * The Assistant's persona: its name and voice, the owner's name and time
 * zone, and quiet hours for notifications. Owner-approved configuration in
 * `<dataRoot>/settings/persona.json`, changed only from Settings or an
 * approved `propose_persona_change` card. It is separate from memory and
 * from policy: nothing here changes what the Assistant may do.
 */

export const DEFAULT_ASSISTANT_NAME = "AgentLink Assistant";
export const DEFAULT_PERSONA_TEXT =
  "You are a friendly, likeable Australian. Be direct and clear, explain things in ordinary language, and keep it warm. A bit of banter now and then is welcome, but never forced slang, and never at the cost of being useful.";
export const DEFAULT_QUIET_HOURS: QuietHours = {
  start: "22:00",
  end: "07:00",
  allowApprovals: true,
};

export const MAX_NAME_LENGTH = 40;
export const MAX_OWNER_NAME_LENGTH = 60;
export const MAX_PERSONA_LENGTH = 2_000;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/u;

export interface QuietHours {
  /** Local `HH:MM` in the persona's time zone. */
  readonly start: string;
  readonly end: string;
  /** Approval requests still notify during quiet hours. */
  readonly allowApprovals: boolean;
}

export interface PersonaSettings {
  readonly name: string;
  readonly persona: string;
  readonly ownerName?: string;
  /** IANA time zone. */
  readonly timeZone: string;
  /** Absent: no quiet hours. */
  readonly quietHours?: QuietHours;
  /** 0 until first saved. */
  readonly updatedAt: number;
}

/** Fields to change; `null` resets an optional field (or the persona text). */
export interface PersonaPatch {
  readonly name?: string;
  readonly persona?: string | null;
  readonly ownerName?: string | null;
  readonly timeZone?: string;
  readonly quietHours?: QuietHours | null;
}

/** What a `propose_persona_change` approval card shows. */
export const PERSONA_CHANGE_DISPLAY_KIND = "assistant_persona_change";

export interface PersonaChangeDisplay {
  readonly kind: typeof PERSONA_CHANGE_DISPLAY_KIND;
  readonly action: "update";
  /** Every change the owner approves, old and new. */
  readonly text: string;
}

export function isPersonaChangeDisplay(
  value: unknown,
): value is PersonaChangeDisplay {
  if (!value || typeof value !== "object") return false;
  const display = value as Record<string, unknown>;
  return (
    display.kind === PERSONA_CHANGE_DISPLAY_KIND &&
    typeof display.text === "string"
  );
}

export class PersonaInputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function defaultPersona(timeZone: string): PersonaSettings {
  return {
    name: DEFAULT_ASSISTANT_NAME,
    persona: DEFAULT_PERSONA_TEXT,
    timeZone,
    quietHours: DEFAULT_QUIET_HOURS,
    updatedAt: 0,
  };
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: value });
    return value.length > 0 && value.length <= 64;
  } catch {
    return false;
  }
}

const ONE_LINE = /^[^\r\n]*$/u;

/** Validate untrusted input; throws `PersonaInputError`. */
export function parsePersonaPatch(body: unknown): PersonaPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PersonaInputError("persona_invalid");
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set([
    "name",
    "persona",
    "ownerName",
    "timeZone",
    "quietHours",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new PersonaInputError("persona_field_unknown");
  }
  const patch: {
    -readonly [K in keyof PersonaPatch]: PersonaPatch[K];
  } = {};
  if ("name" in input) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH || !ONE_LINE.test(name)) {
      throw new PersonaInputError("persona_name_invalid");
    }
    patch.name = name;
  }
  if ("persona" in input) {
    if (input.persona === null) patch.persona = null;
    else {
      const text =
        typeof input.persona === "string" ? input.persona.trim() : "";
      if (!text || text.length > MAX_PERSONA_LENGTH) {
        throw new PersonaInputError("persona_text_invalid");
      }
      patch.persona = text;
    }
  }
  if ("ownerName" in input) {
    if (input.ownerName === null || input.ownerName === "") {
      patch.ownerName = null;
    } else {
      const name =
        typeof input.ownerName === "string" ? input.ownerName.trim() : "";
      if (
        !name ||
        name.length > MAX_OWNER_NAME_LENGTH ||
        !ONE_LINE.test(name)
      ) {
        throw new PersonaInputError("persona_owner_name_invalid");
      }
      patch.ownerName = name;
    }
  }
  if ("timeZone" in input) {
    if (typeof input.timeZone !== "string" || !isTimeZone(input.timeZone)) {
      throw new PersonaInputError("persona_time_zone_invalid");
    }
    patch.timeZone = input.timeZone;
  }
  if ("quietHours" in input) {
    if (input.quietHours === null) patch.quietHours = null;
    else {
      const quiet = input.quietHours as Record<string, unknown> | undefined;
      if (
        !quiet ||
        typeof quiet !== "object" ||
        typeof quiet.start !== "string" ||
        typeof quiet.end !== "string" ||
        !TIME_PATTERN.test(quiet.start) ||
        !TIME_PATTERN.test(quiet.end) ||
        quiet.start === quiet.end ||
        (quiet.allowApprovals !== undefined &&
          typeof quiet.allowApprovals !== "boolean")
      ) {
        throw new PersonaInputError("persona_quiet_hours_invalid");
      }
      patch.quietHours = {
        start: quiet.start,
        end: quiet.end,
        allowApprovals: quiet.allowApprovals !== false,
      };
    }
  }
  return patch;
}

export function applyPersonaPatch(
  current: PersonaSettings,
  patch: PersonaPatch,
  now: number,
): PersonaSettings {
  const next: {
    -readonly [K in keyof PersonaSettings]: PersonaSettings[K];
  } = { ...current, updatedAt: now };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.persona !== undefined) {
    next.persona = patch.persona ?? DEFAULT_PERSONA_TEXT;
  }
  if (patch.ownerName === null) delete next.ownerName;
  else if (patch.ownerName !== undefined) next.ownerName = patch.ownerName;
  if (patch.timeZone !== undefined) next.timeZone = patch.timeZone;
  if (patch.quietHours === null) delete next.quietHours;
  else if (patch.quietHours !== undefined) next.quietHours = patch.quietHours;
  return next;
}

/** What a patch would change, as lines for an approval card. */
export function describePersonaChanges(
  current: PersonaSettings,
  patch: PersonaPatch,
): string[] {
  const next = applyPersonaPatch(current, patch, current.updatedAt);
  const lines: string[] = [];
  if (next.name !== current.name) {
    lines.push(`Name: ${current.name} → ${next.name}`);
  }
  if ((next.ownerName ?? "") !== (current.ownerName ?? "")) {
    lines.push(
      `Your name: ${current.ownerName ?? "(not set)"} → ${next.ownerName ?? "(not set)"}`,
    );
  }
  if (next.timeZone !== current.timeZone) {
    lines.push(`Time zone: ${current.timeZone} → ${next.timeZone}`);
  }
  if (
    describeQuietHours(next.quietHours) !==
    describeQuietHours(current.quietHours)
  ) {
    lines.push(
      `Quiet hours: ${describeQuietHours(current.quietHours)} → ${describeQuietHours(next.quietHours)}`,
    );
  }
  if (next.persona !== current.persona) {
    lines.push(
      "Persona, now:",
      current.persona,
      "",
      "Persona, after:",
      next.persona,
    );
  }
  return lines;
}

export function describeQuietHours(quiet: QuietHours | undefined): string {
  if (!quiet) return "off";
  return `${quiet.start} to ${quiet.end}${quiet.allowApprovals ? ", approval requests still notify" : ""}`;
}

/** Local date in words, for instructions: stable all day for prompt caching. */
export function localDate(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(at);
}

/**
 * The persona block added to a chat's instructions. `owner` chats (the
 * owner's own chats, scheduled runs and briefings) get the voice; `task`
 * chats (coding tasks and their reviews) get the name, time zone and date
 * only, because they write code and PR text in the repository's voice.
 */
export function personaInstructions(
  settings: PersonaSettings,
  kind: "owner" | "task",
  at: number,
): string {
  const owner = settings.ownerName ?? "the owner";
  const when = `${owner === "the owner" ? "The owner's" : `${owner}'s`} time zone is ${settings.timeZone}; today is ${localDate(at, settings.timeZone)}. Give times and dates in that time zone.`;
  if (kind === "task") {
    return [`## Who you are`, `Your name is ${settings.name}.`, when].join(
      "\n",
    );
  }
  return [
    "## Who you are",
    `Your name is ${settings.name}, and you work for ${owner}.`,
    settings.persona,
    when,
    "This persona is how you sound. It was set by the owner and changes nothing about what you may do: permissions, approvals and tools stay as they are. To change it, propose the change with propose_persona_change.",
  ].join("\n\n");
}

/** Minutes since local midnight in `timeZone`, with seconds. */
function localClock(
  at: number,
  timeZone: string,
): { minutes: number; seconds: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    minutes: value("hour") * 60 + value("minute"),
    seconds: value("second"),
  };
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours! * 60 + minutes!;
}

/** Whether `at` falls in the quiet hours (start inclusive, end exclusive). */
export function isQuietTime(
  quiet: QuietHours | undefined,
  timeZone: string,
  at: number,
): boolean {
  if (!quiet) return false;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return false;
  const { minutes } = localClock(at, timeZone);
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

/**
 * Milliseconds from `at` until the quiet hours end (about; a daylight
 * saving change in between is caught by checking again then).
 */
export function untilQuietEnds(
  quiet: QuietHours,
  timeZone: string,
  at: number,
): number {
  const { minutes, seconds } = localClock(at, timeZone);
  const delta = (toMinutes(quiet.end) - minutes + 1_440) % 1_440;
  return Math.max(1_000, delta * 60_000 - seconds * 1_000);
}

export interface PersonaStore {
  get(): PersonaSettings;
  update(patch: PersonaPatch, now: number): Promise<PersonaSettings>;
}

/**
 * Load the persona. A missing file is the defaults; an unreadable one stops
 * the server rather than silently dropping the owner's settings.
 */
export async function openPersonaStore(options: {
  readonly file: string;
  readonly defaultTimeZone: string;
  readonly onChanged?: (settings: PersonaSettings) => void;
}): Promise<PersonaStore> {
  let current = defaultPersona(options.defaultTimeZone);
  let raw: string | undefined;
  try {
    raw = await fs.readFile(options.file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (raw !== undefined) {
    const stored = JSON.parse(raw) as {
      schemaVersion?: unknown;
      settings?: unknown;
    };
    if (stored.schemaVersion !== 1 || !stored.settings) {
      throw new Error(
        `${options.file} is not a persona file this server reads`,
      );
    }
    const settings = stored.settings as Record<string, unknown>;
    const patch = parsePersonaPatch({
      ...(typeof settings.name === "string" ? { name: settings.name } : {}),
      ...(typeof settings.persona === "string"
        ? { persona: settings.persona }
        : {}),
      ...(typeof settings.ownerName === "string"
        ? { ownerName: settings.ownerName }
        : {}),
      ...(typeof settings.timeZone === "string"
        ? { timeZone: settings.timeZone }
        : {}),
      quietHours: settings.quietHours ?? null,
    });
    current = applyPersonaPatch(
      current,
      patch,
      typeof settings.updatedAt === "number" ? settings.updatedAt : 0,
    );
  }
  let writes: Promise<unknown> = Promise.resolve();
  return {
    get: () => current,
    async update(patch, now) {
      const next = applyPersonaPatch(current, patch, now);
      const write = writes.then(async () => {
        await fs.mkdir(path.dirname(options.file), {
          recursive: true,
          mode: 0o700,
        });
        await writeFileAtomic(
          options.file,
          `${JSON.stringify({ schemaVersion: 1, settings: next }, null, 2)}\n`,
        );
      });
      writes = write.catch(() => undefined);
      await write;
      current = next;
      options.onChanged?.(next);
      return next;
    },
  };
}
