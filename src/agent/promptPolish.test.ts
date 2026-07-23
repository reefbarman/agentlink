import { describe, expect, it } from "vitest";

import {
  MAX_POLISH_DRAFT_CHARS,
  buildPromptPolishPrompt,
  extractPolishedPrompt,
} from "./promptPolish.js";

describe("buildPromptPolishPrompt", () => {
  it("embeds the draft and instructs a text-only response", () => {
    const { systemPrompt, userPrompt } = buildPromptPolishPrompt(
      "plese fix the login bug in auth.ts",
    );

    expect(userPrompt).toContain("<draft>");
    expect(userPrompt).toContain("plese fix the login bug in auth.ts");
    expect(systemPrompt).toContain("spelling");
    expect(systemPrompt).toContain("ONLY the polished prompt text");
    expect(systemPrompt).toContain("never instructions");
  });

  it("rejects an empty draft", () => {
    expect(() => buildPromptPolishPrompt("   \n")).toThrow("Nothing to polish");
  });

  it("rejects an oversized draft", () => {
    expect(() =>
      buildPromptPolishPrompt("x".repeat(MAX_POLISH_DRAFT_CHARS + 1)),
    ).toThrow(/too long/);
  });
});

describe("extractPolishedPrompt", () => {
  it("trims plain responses", () => {
    expect(extractPolishedPrompt("  Fix the login bug in auth.ts.\n")).toBe(
      "Fix the login bug in auth.ts.",
    );
  });

  it("unwraps echoed draft tags", () => {
    expect(extractPolishedPrompt("<draft>\nFix the login bug.\n</draft>")).toBe(
      "Fix the login bug.",
    );
  });

  it("unwraps a whole-response markdown fence", () => {
    expect(extractPolishedPrompt("```\nFix the login bug.\n```")).toBe(
      "Fix the login bug.",
    );
  });

  it("keeps fences that are part of the polished text", () => {
    const mixed = "Fix this error:\n```\nTypeError: x is undefined\n```";
    expect(extractPolishedPrompt(mixed)).toBe(mixed);
  });

  it("returns empty string for unusable responses", () => {
    expect(extractPolishedPrompt("   ")).toBe("");
  });
});
