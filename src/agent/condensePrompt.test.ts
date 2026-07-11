import {
  buildDeterministicFallbackSummary,
  extractCondenseResumeAnchor,
  renderDeterministicSections,
} from "./condensePrompt.js";
import { describe, expect, it } from "vitest";

describe("extractCondenseResumeAnchor", () => {
  it("uses the latest user message and pending task", () => {
    expect(
      extractCondenseResumeAnchor({
        userMessages: ["Investigate the issue", "Apply the fix"],
        pendingTasks: ["Inspect logs", "Run validation"],
      }),
    ).toEqual({
      latestUserMessage: "Apply the fix",
      currentTask: "Run validation",
    });
  });

  it("uses the existing unknown fallback for empty inputs", () => {
    expect(
      extractCondenseResumeAnchor({ userMessages: [], pendingTasks: [] }),
    ).toEqual({
      latestUserMessage: "Unknown from transcript",
      currentTask: "Unknown from transcript",
    });
  });
});

describe("renderDeterministicSections", () => {
  it("renders the complete populated resume context", () => {
    expect(
      renderDeterministicSections({
        userMessages: ["Investigate the issue", "Apply the fix"],
        pendingTasks: ["Run validation"],
        resumeAnchor: {
          latestUserMessage: "Apply the fix",
          currentTask: "Run validation",
        },
        preservedContext: {
          toolNames: ["read_file", "execute_command"],
          mcpServerNames: ["linear"],
          activeSkills: ["conventional-commits"],
        },
      }),
    ).toBe(`<system-reminder>
## Resume Anchor (deterministic)
- Latest user message: "Apply the fix"
- Continue from this task: "Run validation"

## Canonical User Messages (deterministic)
1. "Investigate the issue"
2. "Apply the fix"

## Pending Tasks (deterministic heuristic)
- Run validation

## Preserved Runtime Context (reattached outside transcript)
### Available tool names
- read_file
- execute_command

### MCP servers with exposed tools
- linear

### Active loaded skills
- conventional-commits
</system-reminder>`);
  });

  it("renders the existing empty-value markers", () => {
    expect(
      renderDeterministicSections({
        userMessages: [],
        pendingTasks: [],
        resumeAnchor: {
          latestUserMessage: "Unknown from transcript",
          currentTask: "Unknown from transcript",
        },
      }),
    ).toBe(`<system-reminder>
## Resume Anchor (deterministic)
- Latest user message: "Unknown from transcript"
- Continue from this task: "Unknown from transcript"

## Canonical User Messages (deterministic)
1. None

## Pending Tasks (deterministic heuristic)
- None explicitly identified

## Preserved Runtime Context (reattached outside transcript)
### Available tool names
- Unknown

### MCP servers with exposed tools
- None

### Active loaded skills
- None
</system-reminder>`);
  });
});

describe("buildDeterministicFallbackSummary", () => {
  it("preserves the unordered quoted user-message representation", () => {
    expect(
      buildDeterministicFallbackSummary({
        userMessages: ["Investigate the issue", "Apply the fix"],
        pendingTasks: ["Run validation"],
        resumeAnchor: {
          latestUserMessage: "Apply the fix",
          currentTask: "Run validation",
        },
      }),
    )
      .toBe(`1. **Primary Request and Intent**: Continue the active work captured in the latest user message and pending task anchor.

2. **Key Technical Concepts**: Unknown from transcript.

3. **Files and Code Sections**: Unknown from transcript.

4. **Errors and Fixes**: Unknown from transcript.

5. **Problem Solving**: Use the deterministic resume anchor and canonical user messages below as the source of truth.

6. **All User Messages**:
- "Investigate the issue"
- "Apply the fix"

7. **User Corrections & Behavioral Directives**: Unknown from transcript.

8. **Pending Tasks**:
- Run validation

9. **Current Work**: Continue from this task: "Run validation". Latest user message: "Apply the fix".

10. **Optional Next Step**: Resume work on "Run validation".`);
  });

  it("preserves fallback markers for empty lists", () => {
    const output = buildDeterministicFallbackSummary({
      userMessages: [],
      pendingTasks: [],
      resumeAnchor: {
        latestUserMessage: "Unknown from transcript",
        currentTask: "Unknown from transcript",
      },
    });

    expect(output).toContain("6. **All User Messages**:\n- None");
    expect(output).toContain(
      "8. **Pending Tasks**:\n- None explicitly identified",
    );
  });
});
