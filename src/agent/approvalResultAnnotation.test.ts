import { describe, expect, it } from "vitest";

import { getApprovalResultAnnotation } from "./approvalResultAnnotation.js";

describe("getApprovalResultAnnotation", () => {
  it("extracts a follow-up from a standard approval result", () => {
    expect(
      getApprovalResultAnnotation(
        JSON.stringify({
          status: "rejected_by_user",
          reason: "Use the existing command.",
          follow_up: "Keep its frontmatter.",
        }),
      ),
    ).toEqual({ text: "Keep its frontmatter.", badge: "follow-up" });
  });

  it("extracts a standard rejection reason", () => {
    expect(
      getApprovalResultAnnotation(
        JSON.stringify({
          status: "rejected_by_user",
          reason: "Edit the loaded command instead.",
        }),
      ),
    ).toEqual({
      text: "Edit the loaded command instead.",
      badge: "rejection",
    });
  });

  it("recognizes legacy propose_memory rejection payloads", () => {
    expect(
      getApprovalResultAnnotation(
        JSON.stringify({
          status: "rejected",
          rejectionReason: "This should update an existing command.",
        }),
      ),
    ).toEqual({
      text: "This should update an existing command.",
      badge: "rejection",
    });
  });

  it("extracts trailing approval metadata from an MCP result", () => {
    expect(
      getApprovalResultAnnotation(
        '{"issues":[]}\n{"follow_up":"Only inspect this sprint."}',
      ),
    ).toEqual({ text: "Only inspect this sprint.", badge: "follow-up" });
  });
});
