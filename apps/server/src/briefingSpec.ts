/**
 * What a briefing job puts in each briefing: which sections, the news
 * topics, and a length budget. The job's schedule is when it arrives and
 * its prompt is the owner's extra notes.
 */

export const BRIEFING_SECTIONS = [
  "watches",
  "news",
  "calendar",
  "email",
  "open_items",
] as const;
export type BriefingSection = (typeof BRIEFING_SECTIONS)[number];

export const DEFAULT_BRIEFING_WORDS = 300;
export const MIN_BRIEFING_WORDS = 100;
export const MAX_BRIEFING_WORDS = 1_500;
export const MAX_BRIEFING_TOPICS = 10;
const MAX_TOPIC_LENGTH = 80;

export interface BriefingSpec {
  /** In the order they appear. */
  readonly sections: readonly BriefingSection[];
  /** News topics, for the news section. */
  readonly topics: readonly string[];
  readonly maxWords: number;
}

/** What one briefing run covered and how well it was sourced. */
export interface BriefingRunRecord {
  /** Watch changes after this went in (the previous briefing's `through`). */
  readonly since: number;
  /** ...up to this, when the briefing was put together. */
  readonly through: number;
  readonly watchChanges: number;
  /** Bullets without a link, once the briefing was written. */
  readonly unsourced?: number;
}

export class BriefingSpecError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BriefingSpecError";
  }
}

export function isBriefingSection(value: unknown): value is BriefingSection {
  return BRIEFING_SECTIONS.includes(value as BriefingSection);
}

/** Validate a briefing spec from an untrusted body. */
export function parseBriefingSpec(value: unknown): BriefingSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BriefingSpecError("briefing_invalid");
  }
  const body = value as Record<string, unknown>;
  const known = new Set(["sections", "topics", "maxWords"]);
  if (Object.keys(body).some((key) => !known.has(key))) {
    throw new BriefingSpecError("briefing_invalid");
  }
  let sections: BriefingSection[] = [...BRIEFING_SECTIONS];
  if (body.sections !== undefined) {
    if (
      !Array.isArray(body.sections) ||
      body.sections.length === 0 ||
      !body.sections.every(isBriefingSection) ||
      new Set(body.sections).size !== body.sections.length
    ) {
      throw new BriefingSpecError("briefing_sections_invalid");
    }
    sections = [...body.sections];
  }
  let topics: string[] = [];
  if (body.topics !== undefined) {
    if (
      !Array.isArray(body.topics) ||
      body.topics.length > MAX_BRIEFING_TOPICS ||
      !body.topics.every(
        (topic) =>
          typeof topic === "string" &&
          topic.trim().length > 0 &&
          topic.trim().length <= MAX_TOPIC_LENGTH &&
          !/[\r\n]/u.test(topic),
      )
    ) {
      throw new BriefingSpecError("briefing_topics_invalid");
    }
    topics = (body.topics as string[]).map((topic) => topic.trim());
  }
  let maxWords = DEFAULT_BRIEFING_WORDS;
  if (body.maxWords !== undefined) {
    if (
      typeof body.maxWords !== "number" ||
      !Number.isInteger(body.maxWords) ||
      body.maxWords < MIN_BRIEFING_WORDS ||
      body.maxWords > MAX_BRIEFING_WORDS
    ) {
      throw new BriefingSpecError("briefing_length_invalid");
    }
    maxWords = body.maxWords;
  }
  return { sections, topics, maxWords };
}

const SECTION_NAMES: Record<BriefingSection, string> = {
  watches: "watch changes",
  news: "news",
  calendar: "calendar",
  email: "email",
  open_items: "your open items",
};

export function describeBriefingSections(
  sections: readonly BriefingSection[],
): string {
  return sections.map((section) => SECTION_NAMES[section]).join(", ");
}
