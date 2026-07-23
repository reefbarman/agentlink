interface ThinkingContentProps {
  text: string;
}

/**
 * OpenAI reasoning summaries can arrive as adjacent escaped bold fragments:
 * `**First\*\*\*\*Second**`. Turn those boundaries into readable steps
 * without changing ordinary reasoning prose.
 */
export function normalizeThinkingText(text: string): string {
  return text
    .replace(/\\\*/g, "*")
    .replace(/\*\*\s*\*\*/g, "**\n**")
    .trim();
}

export function parseThinkingSteps(text: string): string[] | null {
  const normalized = normalizeThinkingText(text);
  const matches = [...normalized.matchAll(/\*\*([\s\S]*?)\*\*/g)];
  if (matches.length < 2) return null;

  const remainder = normalized.replace(/\*\*([\s\S]*?)\*\*/g, "").trim();
  if (remainder.length > 0) return null;

  const steps = matches
    .map((match) => match[1]?.trim() ?? "")
    .filter((step) => step.length > 0);
  return steps.length >= 2 ? steps : null;
}

export function ThinkingContent({ text }: ThinkingContentProps) {
  const steps = parseThinkingSteps(text);
  if (steps) {
    return (
      <ol class="thinking-steps">
        {steps.map((step, index) => (
          <li key={`${index}:${step}`}>{step}</li>
        ))}
      </ol>
    );
  }

  const normalized = normalizeThinkingText(text).replace(
    /^\s*\*\*(.+?)\*\*\s*$/gm,
    "$1",
  );
  return <pre>{normalized}</pre>;
}
