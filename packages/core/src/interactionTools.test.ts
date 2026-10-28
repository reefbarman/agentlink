import {
  ASK_USER_TOOL,
  MAX_MODE_SWITCH_RESUMES,
  SET_TASK_STATUS_TOOL,
  SWITCH_MODE_TOOL,
  TEASER_FINAL_SUMMARY_REPLACEMENT,
  askUserToolDefinition,
  buildAskUserResultPayload,
  buildModeSwitchResumePrompt,
  buildModeSwitchSkippedPayload,
  buildSwitchModeResultPayload,
  buildTaskStatusMarker,
  buildTaskStatusResultPayload,
  getAskUserModeSwitch,
  isTaskStatus,
  parseAskUserInput,
  switchModeToolDefinition,
} from "./interactionTools.js";
import { describe, expect, it } from "vitest";

describe("switch_mode contract", () => {
  it("keeps VS Code's definition and drops Approve for Me for hosts without it", () => {
    expect(SWITCH_MODE_TOOL.name).toBe("switch_mode");
    expect(SWITCH_MODE_TOOL.input_schema.required).toEqual(["mode"]);
    expect(SWITCH_MODE_TOOL.description).toContain("Approve for Me");
    expect(switchModeToolDefinition({ approveForMe: true })).toBe(
      SWITCH_MODE_TOOL,
    );
    const standalone = switchModeToolDefinition({ approveForMe: false });
    expect(standalone.description).toBe(
      "Request to switch the current agent mode (e.g. from 'code' to 'architect'). The user must approve it. Available modes: code, architect, ask, debug.",
    );
    expect(standalone.input_schema).toEqual(SWITCH_MODE_TOOL.input_schema);
  });

  it("shapes VS Code's results, skip payload and resume message", () => {
    expect(
      buildSwitchModeResultPayload({
        approved: true,
        mode: "code",
        followUp: " go ",
      }),
    ).toEqual({ ok: true, mode: "code", follow_up: "go" });
    expect(
      buildSwitchModeResultPayload({ approved: false, mode: "ask" }),
    ).toEqual({
      status: "rejected_by_user",
      reason: 'User denied mode switch to "ask"',
    });
    expect(
      buildSwitchModeResultPayload({
        approved: false,
        mode: "ask",
        rejectionReason: "stay",
      }),
    ).toEqual({ status: "rejected_by_user", reason: "stay" });
    expect(buildModeSwitchSkippedPayload("code")).toEqual({
      status: "skipped",
      skipped_by: "mode_switch",
      reason:
        "Skipped because mode switched during this tool batch. Continue in the resumed turn.",
      mode: "code",
    });
    expect(
      buildModeSwitchResumePrompt({
        mode: "code",
        reason: "plan approved",
        followUp: "start with tests",
      }),
    ).toBe(
      "You just switched this session to code mode.\nContinue immediately in the new mode and start the next concrete implementation step now.\nSwitch reason: plan approved\nUser follow-up: start with tests",
    );
    expect(MAX_MODE_SWITCH_RESUMES).toBe(10);
  });
});

describe("ask_user contract", () => {
  it("advertises VS Code's questions[] schema", () => {
    expect(ASK_USER_TOOL.name).toBe("ask_user");
    expect(ASK_USER_TOOL.input_schema.required).toEqual(["questions"]);
    const items = (
      ASK_USER_TOOL.input_schema.properties as Record<
        string,
        { items?: { properties: { type: { enum: string[] } } } }
      >
    ).questions!.items!;
    expect(items.properties.type.enum).toEqual([
      "multiple_choice",
      "multiple_select",
      "yes_no",
      "text",
      "scale",
      "confirmation",
    ]);
  });

  it("derives a variant without modeSwitch or a background coordinator", () => {
    expect(
      askUserToolDefinition({ modeSwitch: true, backgroundCoordinator: true }),
    ).toBe(ASK_USER_TOOL);
    const standalone = askUserToolDefinition({
      modeSwitch: false,
      backgroundCoordinator: false,
    });
    expect(standalone.description).toMatch(
      /^Ask one or more structured questions and wait for responses before continuing\. This asks the user\. Prefer `questions\[\]\.context`/,
    );
    expect(standalone.description).not.toContain("modeSwitch");
    expect(standalone.description).toMatch(
      /the selected label is returned as the answer\.$/,
    );
    expect(JSON.stringify(standalone.input_schema)).not.toContain("modeSwitch");
    // The shared definition is not mutated.
    expect(JSON.stringify(ASK_USER_TOOL.input_schema)).toContain("modeSwitch");
  });

  it("trims context and normalises custom confirmation labels", () => {
    expect(
      parseAskUserInput({
        context: "  Shared  ",
        questions: [
          {
            id: "go",
            type: "confirmation",
            question: "Proceed?",
            context: "  why  ",
            options: [" Ship ", "Wait"],
          },
        ],
      }),
    ).toEqual({
      ok: true,
      context: "Shared",
      questions: [
        {
          id: "go",
          type: "confirmation",
          question: "Proceed?",
          context: "why",
          options: ["Ship", "Wait"],
        },
      ],
    });
  });

  it("rejects calls VS Code rejects", () => {
    const question = { id: "q", type: "text", question: "Name?" };
    expect(parseAskUserInput({ questions: [question] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("requires visible context"),
    });
    expect(
      parseAskUserInput({
        context: "c",
        questions: [
          { id: "c1", type: "confirmation", question: "?", options: ["A"] },
        ],
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('Confirmation question "c1"'),
    });
    const modeSwitch = { yes: "code" };
    expect(
      parseAskUserInput({
        context: "c",
        questions: [
          { ...question, id: "a", type: "multiple_choice", modeSwitch },
          { ...question, id: "b", type: "multiple_choice", modeSwitch },
        ],
      }),
    ).toEqual({
      ok: false,
      error: "Only one question per ask_user call may include modeSwitch",
    });
    expect(
      parseAskUserInput({
        context: "c",
        questions: [{ ...question, modeSwitch }],
      }),
    ).toEqual({
      ok: false,
      error: "modeSwitch is only supported on multiple_choice questions",
    });
  });

  it("shapes responses and the selected mode switch", () => {
    const questions = [
      {
        id: "plan",
        type: "multiple_choice" as const,
        question: "How?",
        context: "Trade-off",
        options: ["Plan", "Build"],
        modeSwitch: { Plan: "architect" },
      },
      { id: "name", type: "text" as const, question: "Name?" },
    ];
    const response = {
      answers: { plan: "Plan" },
      notes: { plan: " first " },
      attachments: {
        name: [{ kind: "image" as const, name: "a.png", base64: "AA" }],
      },
    };
    expect(getAskUserModeSwitch(questions, response)).toEqual({
      mode: "architect",
      reason: 'ask_user: "Plan" — first',
    });
    expect(
      buildAskUserResultPayload({
        context: "c",
        questions,
        response,
        modeSwitched: "architect",
      }),
    ).toEqual({
      context: "c",
      responses: [
        {
          question: "How?",
          answer: "Plan",
          context: "Trade-off",
          note: " first ",
        },
        {
          question: "Name?",
          answer: null,
          attachments: [{ kind: "image", name: "a.png" }],
        },
      ],
      modeSwitched: "architect",
    });
    expect(
      getAskUserModeSwitch(questions, {
        answers: { plan: "Build" },
        notes: {},
      }),
    ).toBeUndefined();
  });
});

describe("set_task_status contract", () => {
  it("accepts only VS Code's statuses", () => {
    expect(SET_TASK_STATUS_TOOL.input_schema.required).toEqual(["status"]);
    expect(isTaskStatus("waiting_for_user")).toBe(true);
    expect(isTaskStatus("done")).toBe(false);
  });

  it("builds the final marker", () => {
    expect(
      buildTaskStatusMarker({
        status: "completed",
        params: {
          summary: "  Finished the change.  ",
          continueLabel: "Next",
          continuePrompt: " Do the next step ",
        },
      }),
    ).toEqual({
      status: "completed",
      source: "tool",
      summary: "Finished the change.",
      continueAction: { label: "Next", prompt: "Do the next step" },
    });
    expect(
      buildTaskStatusMarker({
        status: "blocked",
        params: { summary: "Here is the prompt", continueLabel: "Only label" },
      }),
    ).toEqual({
      status: "blocked",
      source: "tool",
      summary: TEASER_FINAL_SUMMARY_REPLACEMENT,
    });
  });

  it("reports completed and ignored completeTodos", () => {
    expect(
      buildTaskStatusResultPayload({
        status: "completed",
        completeTodosRequested: true,
        completedTodos: [{}, {}],
      }),
    ).toEqual({ ok: true, completedTodos: 2 });
    expect(
      buildTaskStatusResultPayload({
        status: "blocked",
        completeTodosRequested: true,
      }),
    ).toEqual({
      ok: true,
      completeTodosIgnored:
        "completeTodos only applies when status is 'completed'",
    });
  });
});
