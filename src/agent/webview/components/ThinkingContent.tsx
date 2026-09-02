interface ThinkingContentProps {
  text: string;
}

const TOKENIZED_NEWLINE_MIN_BOUNDARIES = 4;

/**
 * Some OpenAI-compatible reasoning streams include a newline run after every
 * streamed token. Repair only repeated runs whose neighboring lines are both
 * single token fragments, leaving ordinary prose, paragraphs, lists, and code
 * unchanged.
 */
export function normalizeThinkingText(text: string): string {
  const boundariesByWidth = new Map<
    number,
    { count: number; spacedContinuations: number }
  >();
  for (const match of text.matchAll(/\n+/g)) {
    const before = lineBefore(text, match.index!).trim();
    const after = lineAfter(text, match.index! + match[0].length);
    if (!isSingleTokenFragment(before) || !isSingleTokenFragment(after.trim()))
      continue;
    const boundary = boundariesByWidth.get(match[0].length) ?? {
      count: 0,
      spacedContinuations: 0,
    };
    boundary.count += 1;
    if (/^ [^ ]/.test(after)) boundary.spacedContinuations += 1;
    boundariesByWidth.set(match[0].length, boundary);
  }

  const tokenizedWidth = [...boundariesByWidth.entries()]
    .filter(
      ([, boundary]) =>
        boundary.count >= TOKENIZED_NEWLINE_MIN_BOUNDARIES &&
        boundary.spacedContinuations >= 2,
    )
    .sort((left, right) => right[1].count - left[1].count)[0]?.[0];
  if (tokenizedWidth === undefined) return text;

  return text.replace(
    new RegExp(`\\n{${tokenizedWidth}}`, "g"),
    (newlines, offset) =>
      isSingleTokenFragment(lineBefore(text, offset).trim()) &&
      isSingleTokenFragment(lineAfter(text, offset + newlines.length).trim())
        ? ""
        : newlines,
  );
}

function lineBefore(text: string, offset: number): string {
  return text.slice(0, offset).split("\n").at(-1) ?? "";
}

function lineAfter(text: string, offset: number): string {
  return text.slice(offset).split("\n", 1)[0];
}

function isSingleTokenFragment(value: string): boolean {
  return value.length > 0 && !/\s/.test(value);
}

const ADJACENT_BOLD_BOUNDARY = /(?:(?:\\\*){4}|\*{4})/;

/**
 * OpenAI reasoning summaries can arrive as adjacent bold fragments with raw
 * or escaped joins: `**First****Second**` / `**First\*\*\*\*Second**`.
 * Recognize completed fragments even while the next one is still streaming so
 * the first summary can immediately become a live thinking status.
 */
function areValidThinkingSummaries(summaries: string[]): boolean {
  return (
    summaries.length > 0 &&
    summaries.every((summary) => summary.length > 0 && !summary.includes("*"))
  );
}

function parseThinkingSummaries(text: string): string[] | null {
  const candidate = text.trim();
  if (/[\r\n]/.test(candidate) || !candidate.startsWith("**")) return null;

  if (candidate.endsWith("**")) {
    const summaries = candidate
      .slice(2, -2)
      .split(ADJACENT_BOLD_BOUNDARY)
      .map((summary) => summary.trim());
    if (areValidThinkingSummaries(summaries)) return summaries;
  }

  const fragments = candidate.slice(2).split(ADJACENT_BOLD_BOUNDARY);
  if (fragments.length < 2) return null;
  const completed = fragments.slice(0, -1).map((summary) => summary.trim());
  return areValidThinkingSummaries(completed) ? completed : null;
}

export function getLatestThinkingSummary(text: string): string | null {
  const normalizedText = /[\r\n]/.test(text)
    ? normalizeThinkingText(text)
    : text;
  return parseThinkingSummaries(normalizedText)?.at(-1) ?? null;
}

/** Turn a complete multi-summary value into readable steps. */
export function parseThinkingSteps(text: string): string[] | null {
  const candidate = text.trim();
  if (!candidate.endsWith("**")) return null;
  const summaries = parseThinkingSummaries(candidate);
  return summaries && summaries.length >= 2 ? summaries : null;
}

export function ThinkingContent({ text }: ThinkingContentProps) {
  const normalizedText = normalizeThinkingText(text);
  const steps = parseThinkingSteps(normalizedText);
  if (steps) {
    return (
      <ol class="thinking-steps">
        {steps.map((step, index) => (
          <li key={`${index}:${step}`}>{step}</li>
        ))}
      </ol>
    );
  }

  const summary = parseThinkingSummaries(normalizedText);
  return <pre>{summary?.length === 1 ? summary[0] : normalizedText}</pre>;
}
