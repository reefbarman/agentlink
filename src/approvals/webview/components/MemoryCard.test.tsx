// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import type { ApprovalRequest } from "@agentlink/protocol/approval-transport";
import { MemoryCard } from "./MemoryCard";
import { h } from "preact";

afterEach(() => {
  cleanup();
});

describe("MemoryCard", () => {
  it("normalizes legacy memory proposals to an authoritative tier", () => {
    const submit = vi.fn();
    const request: ApprovalRequest = {
      kind: "memory",
      id: "memory-approval",
      command: "Review durable configuration",
      memoryTier: "memory",
      memoryScope: "project",
      memoryOperation: "add",
      memoryTitle: "Review durable configuration",
      memoryTargetPath: ".agentlink/memory.md",
    };

    render(
      h(MemoryCard, {
        request,
        submit,
        followUpRef: { current: "" },
      }),
    );

    expect(screen.queryByRole("button", { name: "Memory" })).toBeNull();
    expect(screen.getByRole("button", { name: "Instructions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skill" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Command" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    expect(submit).toHaveBeenCalledWith({
      id: "memory-approval",
      decision: "accept",
      memoryTier: "instructions",
      memoryScope: "project",
      memoryName: undefined,
      followUp: undefined,
    });
  });
});
