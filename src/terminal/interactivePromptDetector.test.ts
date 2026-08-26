import {
  INTERACTIVE_PROMPT_MAX_INPUT_CHARS,
  detectInteractivePrompt,
} from "./interactivePromptDetector.js";
import { describe, expect, it } from "vitest";

describe("detectInteractivePrompt", () => {
  it.each([
    ["Continue? ", "confirmation"],
    ["Proceed with changes? [y/N] ", "confirmation"],
    [
      "mise config files are not trusted. Trust them? Yes/No/All ",
      "confirmation",
    ],
    ["Trust this file? Y/N ", "confirmation"],
    ["Press Enter to continue", "press_enter"],
    ["Enter project name: ", "input_request"],
    ["Select an option: ", "choice_request"],
    ["Waiting for confirmation", "waiting_for_input"],
  ] as const)("detects high-confidence prompt %s", (output, kind) => {
    expect(detectInteractivePrompt(output)).toEqual({
      kind,
      confidence: "high",
      evidence: output.trim(),
    });
  });

  it("normalizes ANSI and carriage-return updates", () => {
    expect(
      detectInteractivePrompt(
        "building...\r\u001b[2K\u001b[33mAre you sure?\u001b[0m ",
      ),
    ).toEqual({
      kind: "confirmation",
      confidence: "high",
      evidence: "Are you sure?",
    });
  });

  it("keeps broad workflow hints observation-only", () => {
    expect(
      detectInteractivePrompt("Checking custom code preservation settings..."),
    ).toEqual({
      kind: "custom_code_preservation",
      confidence: "observation",
      evidence: "custom code preservation",
    });
  });

  it("only considers the bounded output tail", () => {
    const output = `Continue?\n${"x".repeat(INTERACTIVE_PROMPT_MAX_INPUT_CHARS)}`;

    expect(detectInteractivePrompt(output)).toBeUndefined();
  });

  it.each([
    "Continue processing records",
    "The user said press enter yesterday.\nWork completed.",
    "Select option parsing passed",
    "Are you sure? yes",
    "Documentation supports yes/no/all choices without prompting",
    "Supported values: Yes/No/All",
    "Build matrix result Y/N/A",
  ])("rejects non-prompt output %s", (output) => {
    expect(detectInteractivePrompt(output)).toBeUndefined();
  });
});
