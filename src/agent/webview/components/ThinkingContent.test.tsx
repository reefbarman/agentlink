/** @vitest-environment jsdom */

import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { parseThinkingSteps, ThinkingContent } from "./ThinkingContent";

afterEach(cleanup);

describe("ThinkingContent", () => {
  it("recognizes escaped and raw adjacent OpenAI summary shapes", () => {
    expect(
      parseThinkingSteps(
        "**Inspecting state\\*\\*\\*\\*Planning the fix\\*\\*\\*\\*Checking tests**",
      ),
    ).toEqual(["Inspecting state", "Planning the fix", "Checking tests"]);
    expect(
      parseThinkingSteps(
        "**Clarifying next execution phase with user****Outlining execution options before proceeding**",
      ),
    ).toEqual([
      "Clarifying next execution phase with user",
      "Outlining execution options before proceeding",
    ]);
  });

  it("does not reinterpret ordinary markdown or text containing asterisks", () => {
    expect(parseThinkingSteps("Compare *pointer and **value** syntax.")).toBe(
      null,
    );
    expect(parseThinkingSteps("Use **** as a literal separator.")).toBe(null);
    expect(parseThinkingSteps("**First *detail*****Second**")).toBe(null);
    expect(
      parseThinkingSteps(
        "Prose before **First\\*\\*\\*\\*Second** and prose after.",
      ),
    ).toBe(null);
  });

  it("renders raw adjacent summaries as a readable step list", () => {
    const { container } = render(
      <ThinkingContent text="**Clarifying the phase****Outlining options**" />,
    );

    expect(
      Array.from(container.querySelectorAll("li")).map(
        (item) => item.textContent,
      ),
    ).toEqual(["Clarifying the phase", "Outlining options"]);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("renders non-matching reasoning text unchanged", () => {
    const text =
      "Compare *pointer and **value** syntax.\nKeep \\* escaped literally.";
    const { container } = render(<ThinkingContent text={text} />);

    expect(container.querySelector("pre")?.textContent).toBe(text);
    expect(container.querySelector(".thinking-steps")).toBeNull();
  });
});
