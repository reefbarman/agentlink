import type {
  TuiControlRequest,
  TuiControlResponse,
} from "./tui/controlTypes.js";
import { describe, expect, it, vi } from "vitest";

import { askQuestionsInControlPanel } from "./questionControls.js";

type Reply = Omit<
  Extract<TuiControlResponse, { cancelled: false }>,
  "requestId" | "cancelled"
>;

function presenter(replies: Reply[]) {
  const requests: TuiControlRequest[] = [];
  const present = vi.fn(async (request: TuiControlRequest) => {
    requests.push(request);
    const reply = replies.shift();
    if (!reply) throw new Error("No reply scripted");
    return { requestId: request.id, cancelled: false as const, ...reply };
  });
  return { present, requests };
}

describe("askQuestionsInControlPanel", () => {
  it("asks all six question types one at a time and collects answers and notes", async () => {
    const { present, requests } = presenter([
      { optionId: "Plan", text: " first " },
      { optionIds: ["Tests", "Docs"] },
      { optionId: "no", text: "" },
      { text: "v2" },
      { optionId: "4" },
      { optionId: "Ship" },
    ]);
    await expect(
      askQuestionsInControlPanel(
        {
          context: "Release",
          questions: [
            {
              id: "how",
              type: "multiple_choice",
              question: "How?",
              context: "Trade-off",
              options: ["Plan", "Build"],
              recommended: "Build",
            },
            {
              id: "what",
              type: "multiple_select",
              question: "What?",
              options: ["Tests", "Docs", "Lint"],
            },
            { id: "ok", type: "yes_no", question: "Ok?" },
            { id: "name", type: "text", question: "Name?" },
            {
              id: "score",
              type: "scale",
              question: "Confidence?",
              scale_min_label: "low",
              scale_max_label: "high",
            },
            {
              id: "go",
              type: "confirmation",
              question: "Go?",
              options: ["Ship", "Hold"],
            },
          ],
        },
        present,
      ),
    ).resolves.toEqual({
      answers: {
        how: "Plan",
        what: ["Tests", "Docs"],
        ok: false,
        name: "v2",
        score: 4,
        go: "Ship",
      },
      notes: { how: "first" },
    });

    expect(requests[0]).toMatchObject({
      kind: "question",
      title: "Agent question 1 of 6",
      body: ["Release", "Trade-off", "How?"],
      initialOptionId: "Build",
      input: { placeholder: "Optional note" },
    });
    expect(requests[0]!.options?.[1]).toEqual({
      id: "Build",
      label: "Build",
      detail: "recommended",
    });
    expect(requests[1]).toMatchObject({ multiSelect: true });
    expect(requests[1]!.input).toBeUndefined();
    expect(requests[2]!.options?.map((option) => option.label)).toEqual([
      "Yes",
      "No",
    ]);
    expect(requests[4]!.options?.map((option) => option.detail)).toEqual([
      "low",
      undefined,
      undefined,
      undefined,
      "high",
    ]);
    // Confirmation submits straight away, with no note field.
    expect(requests[5]!.input).toBeUndefined();
    expect(requests[5]!.options?.map((option) => option.id)).toEqual([
      "Ship",
      "Hold",
    ]);
  });

  it("re-asks a required text question and a typed scale until valid", async () => {
    const { present, requests } = presenter([
      { text: "  " },
      { text: "named" },
      { text: "70" },
      { text: "15" },
    ]);
    await expect(
      askQuestionsInControlPanel(
        {
          context: "",
          questions: [
            { id: "name", type: "text", question: "Name?", context: "Why" },
            {
              id: "pct",
              type: "scale",
              question: "Percent?",
              scale_min: 0,
              scale_max: 50,
            },
          ],
        },
        present,
      ),
    ).resolves.toEqual({ answers: { name: "named", pct: 15 }, notes: {} });
    expect(requests[1]!.body).toEqual([
      "Why",
      "An answer is required.",
      "Name?",
    ]);
    expect(requests[2]!.options).toBeUndefined();
    expect(requests[3]!.body).toContain("Enter a number from 0 to 50.");
  });

  it("marks answers that also switch modes", async () => {
    const { present, requests } = presenter([{ optionId: "Build it" }]);
    await expect(
      askQuestionsInControlPanel(
        {
          context: "",
          questions: [
            {
              id: "next",
              type: "multiple_choice",
              question: "What next?",
              options: ["Build it", "Revise"],
              recommended: "Build it",
              modeSwitch: { "Build it": "code" },
            },
          ],
        },
        present,
      ),
    ).resolves.toEqual({ answers: { next: "Build it" }, notes: {} });
    expect(requests[0]!.options).toEqual([
      {
        id: "Build it",
        label: "Build it",
        detail: "recommended, switches to code mode",
      },
      { id: "Revise", label: "Revise" },
    ]);
    expect(requests[0]!.initialOptionId).toBe("Build it");
  });

  it("cancels the whole call when one question is cancelled", async () => {
    const present = vi.fn(async (request: TuiControlRequest) => ({
      requestId: request.id,
      cancelled: true as const,
    }));
    await expect(
      askQuestionsInControlPanel(
        {
          context: "c",
          questions: [{ id: "q", type: "text", question: "Name?" }],
        },
        present,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
