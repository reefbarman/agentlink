// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FinalMarkerResult } from "./FinalMarkerResult";

afterEach(cleanup);

describe("FinalMarkerResult", () => {
  it("shows distinct Markdown text even when it overlaps the summary", () => {
    const { container } = render(
      <FinalMarkerResult
        summary="Summary"
        result={{ type: "text", text: "Summary\n\n**More detail**" }}
        citations={[]}
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("More detail");
    expect(screen.getByText("Result")).toBeTruthy();
  });

  it.each(["Same content", "  Same content\n"])(
    "omits an identical text result (%s)",
    (text) => {
      const { container } = render(
        <FinalMarkerResult
          summary="Same content"
          result={{ type: "text", text }}
          citations={[]}
        />,
      );
      expect(container.textContent).toBe("");
    },
  );

  it("shows text when the historical marker has no summary", () => {
    render(
      <FinalMarkerResult
        result={{ type: "text", text: "Previously hidden response" }}
        citations={[]}
      />,
    );
    expect(screen.getByText("Previously hidden response")).toBeTruthy();
  });

  it("renders patch files and verification without repeating the summary", () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <FinalMarkerResult
        summary="Patch summary"
        result={{
          type: "patch",
          summary: "Patch summary",
          files: ["src/example.ts"],
          verification: "**Tests passed**",
        }}
        citations={[]}
        onOpenFile={onOpenFile}
      />,
    );
    expect(container.textContent).not.toContain("Patch summary");
    expect(screen.getByText("Tests passed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "src/example.ts" }));
    expect(onOpenFile).toHaveBeenCalledWith("src/example.ts", undefined);
  });

  it("keeps distinct patch summaries and reports an empty file list", () => {
    render(
      <FinalMarkerResult
        summary="Overview"
        result={{ type: "patch", summary: "Patch-specific details", files: [] }}
        citations={[]}
      />,
    );
    expect(screen.getByText("Patch-specific details")).toBeTruthy();
    expect(screen.getByText("No files reported.")).toBeTruthy();
  });

  it("shows line-only finding locations", () => {
    render(
      <FinalMarkerResult
        result={{
          type: "review_findings",
          findings: [
            { severity: "low", message: "Location without a file", line: 7 },
          ],
        }}
        citations={[]}
      />,
    );
    expect(screen.getByText("Line 7")).toBeTruthy();
  });

  it("keeps verification status while omitting a repeated summary", () => {
    const { container } = render(
      <FinalMarkerResult
        summary="Same summary"
        result={{
          type: "verification",
          passed: false,
          summary: "Same summary",
        }}
        citations={[]}
      />,
    );
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(container.textContent).not.toContain("Same summary");
  });

  it("renders review severity, scope and navigable locations", () => {
    const onOpenFile = vi.fn();
    render(
      <FinalMarkerResult
        result={{
          type: "review_findings",
          reviewedScope: "main..feature",
          emptyDiff: false,
          findings: [
            {
              severity: "high",
              message: "**Missing validation**",
              path: "src/example.ts",
              line: 42,
            },
          ],
        }}
        citations={[]}
        onOpenFile={onOpenFile}
      />,
    );
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText("main..feature")).toBeTruthy();
    expect(screen.getByText("Missing validation")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "src/example.ts:42" }));
    expect(onOpenFile).toHaveBeenCalledWith("src/example.ts", 42);
  });

  it.each([true, false])(
    "distinguishes empty review scope from no findings (emptyDiff=%s)",
    (emptyDiff) => {
      render(
        <FinalMarkerResult
          result={{ type: "review_findings", findings: [], emptyDiff }}
          citations={[]}
        />,
      );
      expect(
        screen.getByText(
          emptyDiff
            ? "No diff was available to review."
            : "No findings reported.",
        ),
      ).toBeTruthy();
      expect(
        screen.queryByText(
          emptyDiff
            ? "No findings reported."
            : "No diff was available to review.",
        ),
      ).toBeNull();
    },
  );

  it.each([true, false])(
    "renders verification status, screenshots and literal logs (passed=%s)",
    (passed) => {
      const { container } = render(
        <FinalMarkerResult
          result={{
            type: "verification",
            passed,
            summary: "Verification details",
            screenshots: ["captures/result.png"],
            logs: ["<script>not executable</script>\nline two", "second log"],
          }}
          citations={[]}
        />,
      );
      expect(screen.getByText(passed ? "Passed" : "Failed")).toBeTruthy();
      expect(screen.getByText("Verification details")).toBeTruthy();
      expect(screen.getByText("captures/result.png")).toBeTruthy();
      expect(container.querySelector("script")).toBeNull();
      expect(container.querySelectorAll("pre")).toHaveLength(2);
      expect(container.querySelector("pre")?.textContent).toBe(
        "<script>not executable</script>\nline two",
      );
    },
  );
});
