/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SlashCommandInfo } from "../types";
import { SlashCommandPopup } from "./SlashCommandPopup";
import { h } from "preact";
import { render } from "@testing-library/preact";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("SlashCommandPopup", () => {
  it("renders custom commands, then built-ins, then skills", () => {
    const commands: SlashCommandInfo[] = [
      {
        name: "skill:smoke",
        displayName: "smoke",
        description: "Smoke skill",
        source: "skill",
        builtin: false,
      },
      {
        name: "help",
        description: "Help",
        source: "builtin",
        builtin: true,
      },
      {
        name: "review",
        description: "Review command",
        source: "project",
        builtin: false,
      },
    ];

    const onSelect = vi.fn();

    const { container } = render(
      h(SlashCommandPopup, {
        commands,
        selectedIndex: 0,
        query: "",
        anchor: { bottom: 0, left: 0 },
        onSelect,
        onHover: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    const sections = Array.from(
      container.querySelectorAll(".slash-cmd-section"),
    ).map((section) => section.textContent);
    expect(sections).toEqual(["Project", "Built-in", "Skills"]);

    const names = Array.from(container.querySelectorAll(".slash-cmd-name")).map(
      (name) => name.textContent,
    );
    expect(names).toEqual(["/review", "/help", "/smoke"]);

    const rightLabels = Array.from(
      container.querySelectorAll(".slash-cmd-right"),
    ).map((label) => label.textContent);
    expect(rightLabels).toEqual(["Skill"]);
    expect(container.querySelector('[role="listbox"]')).toBeTruthy();
    expect(
      container.querySelector('[role="option"][aria-selected="true"]'),
    ).toBeTruthy();

    container
      .querySelectorAll<HTMLButtonElement>(".slash-cmd-option")[2]
      ?.click();
    expect(onSelect).toHaveBeenCalledWith(commands[0]);
  });

  it("keeps sub-picker labels human-readable", () => {
    const { getByText, queryByText } = render(
      h(SlashCommandPopup, {
        commands: [
          {
            name: "__mode:code",
            description: "Code",
            source: "builtin",
            builtin: true,
            icon: "code",
            isCurrent: true,
          },
        ],
        selectedIndex: 0,
        query: "",
        anchor: { bottom: 0, left: 0 },
        onSelect: vi.fn(),
        onHover: vi.fn(),
        onClose: vi.fn(),
        isSubView: true,
        subViewTitle: "Switch Mode",
      }),
    );

    expect(getByText("Code")).toBeTruthy();
    expect(queryByText("/__mode:code")).toBeNull();
  });
});
