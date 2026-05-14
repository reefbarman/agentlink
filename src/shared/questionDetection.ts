export interface DetectedQuestionOption {
  label: string;
  payload: string;
}

export interface DetectedQuestion {
  kind: "yes_no" | "single_choice";
  prompt: string;
  options: DetectedQuestionOption[];
}

const SYSTEM_PROMPT = [
  "You analyse the final assistant message in a coding-agent conversation and decide whether it is asking the user a decision question (proposal, choice, approval, offer, request for confirmation, etc.) that should be answered before the agent continues.",
  "",
  "A message IS a decision question even when:",
  "- It has no question mark and is phrased as a statement.",
  '- It is a conditional offer, e.g. "If you want, I can X", "Let me know if you\'d like me to X", "I can X — just say the word", "Happy to X if that helps", "Want me to X?".',
  "- It proposes a next action and waits for approval before continuing.",
  "",
  "A message is NOT a decision question when:",
  "- It is open-ended musing or thinking aloud.",
  "- It is a pure status update with no action offered.",
  "- It is a rhetorical question (no real answer expected).",
  "",
  "Return strict JSON matching the provided schema.",
  '- If it is NOT a decision question, return { "kind": "none" }.',
  '- If it is a yes/no, approval, or single-offer question (including conditional offers), return { "kind": "yes_no", "prompt": <short restatement>, "options": [{"label":"Yes"},{"label":"No"}] }.',
  '- If it offers 2 or more discrete alternatives, return { "kind": "single_choice", "prompt": <short restatement>, "options": [{"label":<short button label>}...] }.',
  "",
  "Examples:",
  "",
  'Assistant: "If you want, after you reinstall and rerun, I can compare the new log immediately and confirm whether the patched wrapper actually took effect."',
  '→ { "kind": "yes_no", "prompt": "Compare the new log after you reinstall and rerun?", "options": [{"label":"Yes"},{"label":"No"}] }',
  "",
  'Assistant: "I can either add unit tests or move on to the next task — which would you prefer?"',
  '→ { "kind": "single_choice", "prompt": "Add unit tests or move on to the next task?", "options": [{"label":"Add tests"},{"label":"Move on"}] }',
  "",
  'Assistant: "Tests are all passing. Committing the fix now."',
  '→ { "kind": "none" }',
  "",
  "Rules for options:",
  "- Labels must be button-sized: 1-5 words, no trailing punctuation, no numbering.",
  "- Do not invent options the assistant did not offer.",
  '- Prefer verbs/actions over full sentences ("Add tests", "Move on", "Roll back").',
  "- Include all distinct options the assistant offered. Keep them mutually distinct.",
  "- prompt should be a short, neutral restatement of what the assistant is asking — not a quote of the full message.",
].join("\n");

export const QUESTION_DETECTION_JSON_SCHEMA = {
  name: "question_detection",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: {
        type: "string",
        enum: ["none", "yes_no", "single_choice"],
      },
      prompt: { type: "string" },
      options: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
          },
          required: ["label"],
        },
      },
    },
    required: ["kind"],
  },
} as const;

export function buildQuestionDetectionMessages(
  assistantText: string,
): Array<{ role: "system" | "user"; content: string }> {
  const trimmed = assistantText.slice(-4000);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Assistant's final message:\n\n${trimmed}`,
    },
  ];
}

export function parseQuestionDetectionJson(
  raw: string,
): DetectedQuestion | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
  return coerceDetectedQuestion(parsed);
}

export function coerceDetectedQuestion(
  value: unknown,
): DetectedQuestion | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const kind = obj.kind;
  if (kind === "none") return null;
  if (kind !== "yes_no" && kind !== "single_choice") return null;

  const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
  if (!prompt) return null;

  const rawOptions = Array.isArray(obj.options) ? obj.options : [];
  const options: DetectedQuestionOption[] = [];
  const seenLabels = new Set<string>();
  for (const entry of rawOptions) {
    if (!entry || typeof entry !== "object") continue;
    const label =
      typeof (entry as Record<string, unknown>).label === "string"
        ? ((entry as Record<string, unknown>).label as string).trim()
        : "";
    if (!label || seenLabels.has(label)) continue;
    seenLabels.add(label);
    options.push({ label, payload: label });
  }

  if (kind === "yes_no") {
    const hasYes = options.some((o) => /^yes\b/i.test(o.label));
    const hasNo = options.some((o) => /^no\b/i.test(o.label));
    const finalOptions =
      hasYes && hasNo
        ? options.slice(0, 2)
        : [
            { label: "Yes", payload: "Yes" },
            { label: "No", payload: "No" },
          ];
    return { kind: "yes_no", prompt, options: finalOptions };
  }

  if (options.length < 2) return null;
  return { kind: "single_choice", prompt, options };
}
