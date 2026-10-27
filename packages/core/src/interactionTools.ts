import type { CoreModelToolDefinition as ToolDefinition } from "./modelRuntime.js";
import type {
  FinalMessageMarker,
  FinalMessageStatus,
} from "@agentlink/protocol/final-status";
import type { FleetResultEnvelope } from "@agentlink/protocol/fleet-result";
import {
  getConfirmationOptions,
  isConfirmationOptions,
} from "@agentlink/protocol/question-confirmation";
import type {
  UserQuestion,
  UserQuestionResponse,
} from "@agentlink/protocol/structured-question";

/**
 * VS Code's `ask_user` and `set_task_status` contracts: tool definitions,
 * input validation, and result shaping. Hosts supply how a question is
 * asked, how a mode switch is applied, and where a final status is shown.
 */

/** Schema for the ask_user tool (always available in all modes). */
export const ASK_USER_TOOL: ToolDefinition = {
  name: "ask_user",
  description:
    "Ask one or more structured questions and wait for responses before continuing. In a foreground session this asks the user. In a native background session the root foreground coordinator answers first and decides whether human escalation is necessary. Prefer `questions[].context`: visible text for that specific question explaining why input is needed, the relevant trade-off/options, and your recommendation. Use top-level `context` only for a brief shared intro that applies to every question. For multi-question asks, split context across the individual questions instead of delivering one large block. Questions must be self-contained and must not rely on hidden thinking or prior messages; preceding assistant text does not satisfy the context requirement. Use `recommended` whenever you recommend a choice: it must exactly match the option label (use `Yes` or `No` for `yes_no`, or the numeric value as a string for `scale`) and renders a recommendation badge. Do not write \"(recommended)\" into an option label. Use `confirmation` for a direct two-button decision: it submits immediately without a separate acknowledgement or Submit/Cancel control. It defaults to `Yes` and `No`; provide exactly two distinct `options` strings to name its buttons, and the selected label is returned as the answer. To combine a user choice with a mode change (e.g. 'plan first → architect, just implement → code'), use a `multiple_choice` question with a `modeSwitch` map instead of calling `switch_mode` separately — this avoids a redundant approval. Only one question per call may include `modeSwitch`.",
  input_schema: {
    type: "object",
    properties: {
      context: {
        type: "string",
        description:
          "Optional brief shared intro shown above the questions. Use only for context that applies to every question; put question-specific rationale in questions[].context.",
      },
      questions: {
        type: "array",
        description:
          "The questions to ask. All are shown at once; the user answers all before you continue.",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "Unique identifier for this question (used to map answers back)",
            },
            type: {
              type: "string",
              enum: [
                "multiple_choice",
                "multiple_select",
                "yes_no",
                "text",
                "scale",
                "confirmation",
              ],
              description: "Question type",
            },
            question: {
              type: "string",
              description: "The question text shown to the user",
            },
            context: {
              type: "string",
              description:
                "Visible context shown with this specific question. Prefer this over top-level context, especially when asking multiple questions. Explain the local trade-off/options and include your recommendation when relevant.",
            },
            options: {
              type: "array",
              items: { type: "string" },
              description:
                "Answer options (required for multiple_choice and multiple_select). For confirmation, provide exactly two distinct labels to replace the default Yes/No buttons.",
            },
            recommended: {
              type: "string",
              description:
                "Recommended option value. Match an option label exactly (use Yes or No for yes_no), or use the numeric value as a string for scale; renders a recommendation badge.",
            },
            allowBlank: {
              type: "boolean",
              description:
                "Allows submitting a blank text answer. Only applies to text questions.",
            },
            scale_min: {
              type: "number",
              description: "Scale minimum (default: 1)",
            },
            scale_max: {
              type: "number",
              description: "Scale maximum (default: 5)",
            },
            scale_min_label: {
              type: "string",
              description: "Label for the low end of the scale",
            },
            scale_max_label: {
              type: "string",
              description: "Label for the high end of the scale",
            },
            modeSwitch: {
              type: "object",
              description:
                "Maps answer values (option strings) to agent mode slugs. When the user picks a mapped answer, the agent switches mode as part of submission — no separate switch_mode approval is shown. Only valid on multiple_choice questions, and only one question per ask_user call may include modeSwitch. Available modes: code, architect, ask, debug, review (plus any custom modes).",
              additionalProperties: { type: "string" },
            },
          },
          required: ["id", "type", "question"],
        },
      },
    },
    required: ["questions"],
  },
};

/** Base schema for final task status; background result fields are added per run. */
export const SET_TASK_STATUS_TOOL: ToolDefinition = {
  name: "set_task_status",
  description:
    "Mark the current turn's final status and end the current response unless another user interjection is already pending. Unfinished todos do not resume automatically after this tool. Use only when your response is final: completed, waiting_for_user, blocked, or cancelled. Do not call before ask_user, for intermediate progress updates, or to answer an interjected question when you intend to resume earlier work afterward; use ordinary visible text in those cases. The summary is the turn's final message: the complete response itself (answer, findings, artifact, or change report), not a meta-description. Do not also write it as text before this call. Never use summary as a teaser such as 'Here is the prompt' or 'See below'; content after this tool call is not a reliable place to deliver the answer. For code-modifying work, structure the summary around what changed, why it matters, validation run or skipped, and concrete follow-up. Include a short continuation button label and prompt when the user can safely continue with one click, especially when the summary mentions a concrete next phase, MVP slice, remaining plan item, follow-up task, or validation step.",
  input_schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["completed", "waiting_for_user", "blocked", "cancelled"],
      },
      summary: {
        type: "string",
        description:
          "The turn's final message, shown in the final-status card. Markdown is rendered. Must contain all the substance the user asked for (answer, explanation, findings, artifact, or result), not a meta-description or a recap of text already written. If the summary says 'here is', 'below', 'paste this', 'the prompt is', or otherwise promises an artifact, the complete artifact must be included in this same summary (for example, in a fenced code block). Never rely on text after set_task_status to provide missing content. Never write 'Explained X', 'Answered Y', 'Reviewed Z', or similar past-tense recaps. For non-trivial code-modifying work, structure as what changed (key files/behavior), why it matters, validation run, validation skipped with reasons, and concrete follow-up. Size it to the content: one sentence for a tiny answer, a full structured breakdown for detailed explanations or non-trivial work; do not reduce meaningful work to 'Done' or 'All set'. Keep it final and avoid open-ended questions or generic offers for further assistance.",
      },
      continueLabel: {
        type: "string",
        description:
          "Button label for a clear next-step continuation. Provide this with continuePrompt when the final summary names a concrete follow-up, next phase, MVP slice, remaining plan item, subtask, or validation step.",
      },
      completeTodos: {
        type: "boolean",
        description:
          "When true with status='completed', mark all currently visible todos completed as part of this final status call. Use instead of a separate todo_write call only when the existing todo list accurately represents finished work.",
      },
      continuePrompt: {
        type: "string",
        description:
          "Visible user message sent when the continuation button is clicked. Make it specific enough to start the named next step, not just a generic 'continue', whenever there is remaining work from the original plan or a concrete follow-up in the summary. Wrap any command, slash command, file path, or code in backticks (for example `npm test`) so sending the prompt unchanged cannot invoke it as a command.",
      },
    },
    required: ["status"],
  },
};

// ── ask_user ──

export type AskUserInput =
  | {
      readonly ok: true;
      readonly context: string;
      readonly questions: UserQuestion[];
    }
  | { readonly ok: false; readonly error: string };

/**
 * Validate and normalise `ask_user` input exactly as VS Code does: trimmed
 * context, custom confirmation labels, required visible context, and at most
 * one `modeSwitch`, only on a multiple_choice question.
 */
export function parseAskUserInput(
  params: Record<string, unknown>,
): AskUserInput {
  const context = String(params.context ?? "").trim();
  const rawQuestions: unknown[] = Array.isArray(params.questions)
    ? params.questions
    : [];
  const invalidConfirmation = rawQuestions.find((question) => {
    if (!question || typeof question !== "object") return false;
    const q = question as UserQuestion;
    return (
      q.type === "confirmation" &&
      q.options !== undefined &&
      !isConfirmationOptions(q.options)
    );
  }) as UserQuestion | undefined;
  const questions: UserQuestion[] = rawQuestions.flatMap((question) => {
    if (!question || typeof question !== "object") return [];
    const q = question as UserQuestion;
    return [
      {
        ...q,
        context: typeof q.context === "string" ? q.context.trim() : q.context,
        ...(q.type === "confirmation" && q.options !== undefined
          ? { options: getConfirmationOptions(q.options) }
          : {}),
      },
    ];
  });
  if (invalidConfirmation) {
    return {
      ok: false,
      error: `Confirmation question "${invalidConfirmation.id}" must have exactly two distinct non-empty options when custom button labels are provided`,
    };
  }
  const hasQuestionContext = questions.some((q) => q.context?.trim());
  if (!context && !hasQuestionContext) {
    return {
      ok: false,
      error:
        "ask_user requires visible context in this tool call, either top-level context or questions[].context. Preceding assistant messages are intentionally not used because the question card must remain self-contained.",
    };
  }
  // Reject calls that include modeSwitch on more than one question or on
  // unsupported question types — keeps a single, unambiguous mode change
  // per ask_user invocation.
  const modeSwitchQuestions = questions.filter(
    (q) => q.modeSwitch && Object.keys(q.modeSwitch).length > 0,
  );
  if (modeSwitchQuestions.length > 1) {
    return {
      ok: false,
      error: "Only one question per ask_user call may include modeSwitch",
    };
  }
  const modeSwitchQuestion = modeSwitchQuestions[0];
  if (modeSwitchQuestion && modeSwitchQuestion.type !== "multiple_choice") {
    return {
      ok: false,
      error: "modeSwitch is only supported on multiple_choice questions",
    };
  }
  return { ok: true, context, questions };
}

/** One `responses[]` entry per question, in question order. */
export function buildAskUserResponses(
  questions: readonly UserQuestion[],
  response: UserQuestionResponse,
): Record<string, unknown>[] {
  return questions.map((q) => {
    const answer = response.answers[q.id];
    const note = response.notes[q.id];
    const attachments = response.attachments?.[q.id] ?? [];
    const entry: Record<string, unknown> = {
      question: q.question,
      answer: answer ?? null,
    };
    if (q.context) entry.context = q.context;
    if (note) entry.note = note;
    if (attachments.length > 0) {
      entry.attachments = attachments.map((attachment) => ({
        kind: attachment.kind,
        name: attachment.name,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(attachment.path ? { path: attachment.path } : {}),
      }));
    }
    return entry;
  });
}

/** The mode switch the user's answer selected, if any. */
export function getAskUserModeSwitch(
  questions: readonly UserQuestion[],
  response: UserQuestionResponse,
): { readonly mode: string; readonly reason: string } | undefined {
  const modeSwitchQuestion = questions.find(
    (q) => q.modeSwitch && Object.keys(q.modeSwitch).length > 0,
  );
  if (!modeSwitchQuestion) return undefined;
  const answer = response.answers[modeSwitchQuestion.id];
  const mapping = modeSwitchQuestion.modeSwitch;
  if (!mapping || typeof answer !== "string") return undefined;
  const targetMode = mapping[answer];
  if (!targetMode) return undefined;
  const note = response.notes[modeSwitchQuestion.id]?.trim();
  return {
    mode: targetMode,
    reason: note ? `ask_user: "${answer}" — ${note}` : `ask_user: "${answer}"`,
  };
}

/** The `ask_user` result payload; media attachments are host-rendered. */
export function buildAskUserResultPayload(args: {
  readonly context: string;
  readonly questions: readonly UserQuestion[];
  readonly response: UserQuestionResponse;
  readonly modeSwitched?: string;
  readonly followUp?: string;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    context: args.context,
    responses: buildAskUserResponses(args.questions, args.response),
  };
  if (args.modeSwitched) payload.modeSwitched = args.modeSwitched;
  if (args.followUp) payload.follow_up = args.followUp;
  return payload;
}

// ── set_task_status ──

export function isTaskStatus(value: unknown): value is FinalMessageStatus {
  return (
    value === "completed" ||
    value === "waiting_for_user" ||
    value === "blocked" ||
    value === "cancelled"
  );
}

export const TEASER_FINAL_SUMMARY_REPLACEMENT =
  "Task status was set, but the final summary only promised an artifact and did not include it. Expand the `set_task_status` tool input below to inspect what the agent attempted to send.";

/**
 * The final marker for a validated `set_task_status` call. A teaser-only
 * summary is replaced, and a continue action needs both label and prompt.
 */
export function buildTaskStatusMarker(args: {
  readonly status: FinalMessageStatus;
  readonly params: Record<string, unknown>;
  readonly result?: FleetResultEnvelope;
}): FinalMessageMarker {
  const { params } = args;
  let summary = typeof params.summary === "string" ? params.summary.trim() : "";
  if (isTeaserOnlyFinalSummary(summary)) {
    summary = TEASER_FINAL_SUMMARY_REPLACEMENT;
  }
  const continueLabel =
    typeof params.continueLabel === "string" ? params.continueLabel.trim() : "";
  const continuePrompt =
    typeof params.continuePrompt === "string"
      ? params.continuePrompt.trim()
      : "";
  return {
    status: args.status,
    source: "tool",
    ...(summary ? { summary } : {}),
    ...(args.result ? { result: args.result } : {}),
    ...(continueLabel && continuePrompt
      ? { continueAction: { label: continueLabel, prompt: continuePrompt } }
      : {}),
  };
}

/** The `set_task_status` success payload. */
export function buildTaskStatusResultPayload(args: {
  readonly status: FinalMessageStatus;
  readonly completeTodosRequested: boolean;
  /** Todos marked complete, when the host completed them. */
  readonly completedTodos?: readonly unknown[];
}): Record<string, unknown> {
  const completeTodosIgnored =
    args.completeTodosRequested && args.status !== "completed";
  return {
    ok: true,
    ...(args.completedTodos
      ? { completedTodos: args.completedTodos.length }
      : {}),
    ...(completeTodosIgnored
      ? {
          completeTodosIgnored:
            "completeTodos only applies when status is 'completed'",
        }
      : {}),
  };
}

// ── Final summary heuristics ──
// Shared by VS Code's set_task_status handling and the browser Ask Agent turn
// loop so both enforce "the summary is the response, not a receipt".

function normalizeSummaryLine(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const TEASER_OPENING =
  /^(?:you'?re right\s*[—-]\s*)?(?:here(?:'s| is)|below is|paste this|copy this)\b/;

const RECAP_OPENING =
  /^(?:i(?:'ve| have)?\s+)?(?:prepared|created|drafted|wrote|written|compiled|generated|built|produced|provided|put together|assembled|composed|developed|summari[sz]ed|outlined|researched|gathered|analy[sz]ed|reviewed|explained|answered|completed|finished|delivered|done)\b/;

function hasObviousPayload(summary: string, claimOpening: RegExp): boolean {
  return (
    summary.includes("```") ||
    /`[^`]+`/.test(summary) ||
    /:\s*\S.{24,}/s.test(summary) ||
    summary.split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      if (trimmed.length < 40) return false;
      return !claimOpening.test(normalizeSummaryLine(trimmed));
    })
  );
}

/**
 * A summary that promises an artifact ("Here is the prompt", "Paste this
 * command") without actually including it.
 */
export function isTeaserOnlyFinalSummary(summary: string): boolean {
  const normalized = normalizeSummaryLine(summary);
  if (!normalized) return false;

  const startsLikeTeaser = TEASER_OPENING.test(normalized);
  const namesArtifact =
    /\b(prompt|answer|command|snippet|code|plan|review|message|response|text|artifact)\b/.test(
      normalized,
    );
  if (!startsLikeTeaser || !namesArtifact) return false;

  return !hasObviousPayload(summary, TEASER_OPENING);
}

/**
 * A summary that only recaps work in the past tense ("Prepared a meeting
 * guide with…") without the described content anywhere in it. Only meaningful
 * when no other response text was delivered — a recap next to a full streamed
 * answer is fine.
 */
export function isRecapOnlyFinalSummary(summary: string): boolean {
  const normalized = normalizeSummaryLine(summary);
  if (!normalized) return false;
  if (!RECAP_OPENING.test(normalized)) return false;
  // A genuine deliverable is usually multi-line or long; a recap is a single
  // short sentence or two describing what was (supposedly) produced.
  if (summary.trim().split(/\r?\n/).length > 2) return false;
  if (normalized.length > 400) return false;
  return !hasObviousPayload(summary, RECAP_OPENING);
}
