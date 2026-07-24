interface ThinkingContentProps {
  text: string;
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

  return <pre>{text}</pre>;
}
