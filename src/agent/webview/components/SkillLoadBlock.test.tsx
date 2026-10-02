// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

import { RemoteToolDetailProvider } from "./RemoteToolDetail";
import { SkillLoadBlock } from "./SkillLoadBlock";

afterEach(() => {
  cleanup();
});

describe("SkillLoadBlock", () => {
  it("renders stopped results as warning", () => {
    const { container } = render(
      <SkillLoadBlock
        block={{
          type: "skill_load",
          id: "tool-1",
          inputJson: "{}",
          result: JSON.stringify({ status: "stopped" }),
          complete: true,
          skillName: "push-to-repo",
          path: "/tmp/skill.md",
          content: undefined,
        }}
      />,
    );

    const root = container.querySelector(".tool-call-block");
    expect(root?.classList.contains("tool-warning")).toBe(true);
  });

  it("renders completed non-stopped results as success", () => {
    const { container } = render(
      <SkillLoadBlock
        block={{
          type: "skill_load",
          id: "tool-2",
          inputJson: "{}",
          result: JSON.stringify({ status: "loaded" }),
          complete: true,
          skillName: "push-to-repo",
          path: "/tmp/skill.md",
          content: undefined,
        }}
      />,
    );

    const root = container.querySelector(".tool-call-block");
    expect(root?.classList.contains("tool-success")).toBe(true);
  });

  it("loads skill content on expansion and shows update-required details", async () => {
    const projected = {
      type: "skill_load" as const,
      id: "remote-skill",
      inputJson: "{}",
      result: "",
      complete: false,
      skillName: "remote-skill",
      remoteDetail: {
        messageId: "message",
        contentRevision: 1,
        available: true,
      },
    };
    const loadDetail = vi.fn(async () => ({
      ...projected,
      complete: true,
      content: "Restored skill content",
      result: "loaded",
    }));
    render(
      <RemoteToolDetailProvider
        scopeKey="browser-session"
        loadDetail={loadDetail}
      >
        <SkillLoadBlock block={projected} />
      </RemoteToolDetailProvider>,
    );
    expect(loadDetail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /load_skill/i }));
    await waitFor(() =>
      expect(screen.getByText("Restored skill content")).toBeTruthy(),
    );
    expect(loadDetail).toHaveBeenCalledTimes(1);
  });

  it("renders failed status as error", () => {
    const { container } = render(
      <SkillLoadBlock
        block={{
          type: "skill_load",
          id: "tool-3",
          inputJson: "{}",
          result: JSON.stringify({ status: "failed" }),
          complete: true,
          skillName: "push-to-repo",
          path: "/tmp/skill.md",
          content: undefined,
        }}
      />,
    );

    const root = container.querySelector(".tool-call-block");
    expect(root?.classList.contains("tool-error")).toBe(true);
  });
});
