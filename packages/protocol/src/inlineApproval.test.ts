import type {
  InlineApprovalDecision,
  InlineApprovalRequest,
  InlineApprovalResult,
  OnApprovalRequest,
} from "./inlineApproval.js";
import { describe, expectTypeOf, it } from "vitest";

describe("inline approval protocol", () => {
  it("keeps request cards serializable and distinguishes file writes", () => {
    const request: InlineApprovalRequest = {
      kind: "write",
      title: "Review write",
      detail: "Create src/example.ts",
      choices: [{ label: "Accept", value: "accept", isPrimary: true }],
      targetPath: "/workspace/src/example.ts",
      fileWrite: { operation: "create", outsideWorkspace: false },
    };

    expectTypeOf(request).toMatchTypeOf<InlineApprovalRequest>();
    expectTypeOf(request.fileWrite).toEqualTypeOf<
      { operation: "create" | "modify"; outsideWorkspace: boolean } | undefined
    >();
  });

  it("keeps rich decisions and string compatibility in one result envelope", () => {
    const decision: InlineApprovalDecision = {
      decision: "accept",
      editedContent: "# Project instructions",
      memoryTier: "instructions",
      memoryScope: "project",
      memoryName: "instructions",
      followUp: "Continue",
    };
    const legacy: InlineApprovalResult = "accept";

    expectTypeOf(decision).toMatchTypeOf<InlineApprovalResult>();
    expectTypeOf(legacy).toMatchTypeOf<InlineApprovalResult>();
  });

  it("keeps the host callback as the complete request and decision seam", () => {
    expectTypeOf<Parameters<OnApprovalRequest>>().toEqualTypeOf<
      [request: InlineApprovalRequest, sessionId?: string]
    >();
    expectTypeOf<
      Awaited<ReturnType<OnApprovalRequest>>
    >().toEqualTypeOf<InlineApprovalResult>();
  });
});
