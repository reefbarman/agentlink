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

    const { container } = render(
      h(SlashCommandPopup, {
        commands,
        selectedIndex: 0,
        anchor: { bottom: 0, left: 0 },
        onSelect: vi.fn(),
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
    expect(names).toEqual(["/review", "/help", "/skill:smoke"]);
  });
});
