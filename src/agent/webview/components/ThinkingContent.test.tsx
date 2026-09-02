/** @vitest-environment jsdom */

import {
  ThinkingContent,
  getLatestThinkingSummary,
  normalizeThinkingText,
  parseThinkingSteps,
} from "./ThinkingContent";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/preact";

afterEach(cleanup);

describe("ThinkingContent", () => {
  it("repairs tokenized newline runs from OpenAI-compatible reasoning", () => {
    expect(
      normalizeThinkingText(
        "Let\n me\n read\n the\n Open\nRouter\n reasoning\n docs.\n\nA real paragraph remains.",
      ),
    ).toBe(
      "Let me read the OpenRouter reasoning docs.\n\nA real paragraph remains.",
    );
    expect(
      normalizeThinkingText(
        "Search\n\n\n results\n\n\n are\n\n\n mostly\n\n\n noise\n\n\n today.",
      ),
    ).toBe("Search results are mostly noise today.");
    expect(
      normalizeThinkingText("Uses\n COD\nEX\n_DEF\nAULT\n_MODEL\n in\n tests."),
    ).toBe("Uses CODEX_DEFAULT_MODEL in tests.");
  });

  it("preserves ordinary line breaks, paragraphs, lists, and code", () => {
    const ordinary = [
      "One token",
      "per line",
      "is valid prose.",
      "",
      "- first item",
      "- second item",
      "",
      "const value = 1;",
    ].join("\n");
    expect(normalizeThinkingText(ordinary)).toBe(ordinary);
    expect(normalizeThinkingText("One\nword\nper\nline\nhere")).toBe(
      "One\nword\nper\nline\nhere",
    );
  });

  it("recognizes the latest OpenAI summary from the first completed fragment", () => {
    expect(getLatestThinkingSummary("**Inspecting state**")).toBe(
      "Inspecting state",
    );
    expect(
      getLatestThinkingSummary("**Inspecting state****Planning the fix**"),
    ).toBe("Planning the fix");
    expect(
      getLatestThinkingSummary("**Inspecting state****Planning the fix"),
    ).toBe("Inspecting state");
    expect(getLatestThinkingSummary("**Inspecting state****")).toBe(
      "Inspecting state",
    );
    expect(getLatestThinkingSummary("Inspecting **ordinary** text")).toBeNull();
  });

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

  it("renders a single OpenAI summary without markdown delimiters", () => {
    const { container } = render(
      <ThinkingContent text="**Inspecting state**" />,
    );

    expect(container.querySelector("pre")?.textContent).toBe(
      "Inspecting state",
    );
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

  it("renders normalized reasoning without changing the source text", () => {
    const text = "Let\n me\n inspect\n this\n captured\n response.";
    const { container } = render(<ThinkingContent text={text} />);

    expect(container.querySelector("pre")?.textContent).toBe(
      "Let me inspect this captured response.",
    );
    expect(text).toBe("Let\n me\n inspect\n this\n captured\n response.");
  });

  it("renders non-matching reasoning text unchanged", () => {
    const text =
      "Compare *pointer and **value** syntax.\nKeep \\* escaped literally.";
    const { container } = render(<ThinkingContent text={text} />);

    expect(container.querySelector("pre")?.textContent).toBe(text);
    expect(container.querySelector(".thinking-steps")).toBeNull();
  });
});
