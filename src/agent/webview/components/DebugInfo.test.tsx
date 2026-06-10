// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { DebugInfo } from "./DebugInfo.js";

afterEach(() => cleanup());

describe("DebugInfo", () => {
  it("shows deferred rule metadata separately from prompt chars", () => {
    render(
      <DebugInfo
        info={{ platform: "darwin" }}
        loadedInstructions={[
          {
            source: "AGENTS.md",
            chars: 120,
            promptChars: 120,
            kind: "instruction",
            deferred: false,
          },
          {
            source: ".agentlink/rules/legacy.md",
            chars: 300,
            promptChars: 300,
            kind: "rule",
            deferred: false,
            hasFrontmatter: false,
            alwaysApply: true,
            summary: "Legacy standards",
          },
          {
            source: ".agentlink/rules/typescript.md",
            chars: 2_400,
            promptChars: 0,
            kind: "rule",
            deferred: true,
            hasFrontmatter: true,
            loadPath: ".agentlink/rules/typescript.md",
            summary: "TypeScript standards",
            globs: ["src/**/*.ts", "tests/**/*.ts"],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByText("Environment"));

    expect(
      screen.getByText(
        "Loaded Instructions (3 files, 420 body prompt chars · 1 deferred · 2,820 source chars)",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByText(/Loaded Instructions/));

    expect(screen.getByText("AGENTS.md")).toBeTruthy();
    expect(screen.getByText(".agentlink/rules/legacy.md")).toBeTruthy();
    expect(screen.getByText(".agentlink/rules/typescript.md")).toBeTruthy();
    expect(screen.getByText(/inline · default/)).toBeTruthy();

    const truncatedRuleDetail = screen.getByText(
      /deferred · 0 body prompt chars/,
    );
    expect(truncatedRuleDetail).toBeTruthy();
    fireEvent.click(truncatedRuleDetail);

    expect(
      screen.getByText(
        "deferred · 0 body prompt chars · 2,400 source chars · summary: TypeScript standards · globs: src/**/*.ts, tests/**/*.ts · load: .agentlink/rules/typescript.md",
      ),
    ).toBeTruthy();
  });
});
