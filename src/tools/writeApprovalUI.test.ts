import { describe, it, expect } from "vitest";
import { decisionToScope } from "./writeApprovalUI.js";
import type { DiffDecision } from "../integrations/DiffViewProvider.js";

describe("decisionToScope", () => {
  it("maps accept-session to session", () => {
    expect(decisionToScope("accept-session")).toBe("session");
  });

  it("maps accept-project to project", () => {
    expect(decisionToScope("accept-project")).toBe("project");
  });

  it("maps accept-always to global", () => {
    expect(decisionToScope("accept-always")).toBe("global");
  });

  it("returns null for accept (run-once)", () => {
    expect(decisionToScope("accept")).toBeNull();
  });

  it("returns null for reject", () => {
    expect(decisionToScope("reject")).toBeNull();
  });
});
