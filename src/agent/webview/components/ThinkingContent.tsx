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

/**
 * OpenAI reasoning summaries can arrive as adjacent bold fragments with raw
 * or escaped joins: `**First****Second**` / `**First\*\*\*\*Second**`.
 * Turn only that whole-value shape into readable steps.
 */
export function parseThinkingSteps(text: string): string[] | null {
  const candidate = text.trim();
  if (
    /[\r\n]/.test(candidate) ||
    !candidate.startsWith("**") ||
    !candidate.endsWith("**")
  ) {
    return null;
  }

  const inner = candidate.slice(2, -2);
  const adjacentBoldBoundary = /(?:(?:\\\*){4}|\*{4})/g;
  if (!adjacentBoldBoundary.test(inner)) return null;

  const steps = inner.split(/(?:(?:\\\*){4}|\*{4})/).map((step) => step.trim());
  return steps.length >= 2 &&
    steps.every((step) => step.length > 0 && !step.includes("*"))
    ? steps
    : null;
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

  return <pre>{normalizedText}</pre>;
}
