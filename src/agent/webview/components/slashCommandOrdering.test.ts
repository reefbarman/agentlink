import { describe, expect, it } from "vitest";
import {
  groupSlashCommandsForPicker,
  orderSlashCommandsForPicker,
} from "./slashCommandOrdering";

import type { SlashCommandInfo } from "../types";

const commands: SlashCommandInfo[] = [
  {
    name: "help",
    description: "Help",
    source: "builtin",
    builtin: true,
  },
  {
    name: "skill:smoke",
    description: "Smoke",
    source: "skill",
    builtin: false,
  },
  {
    name: "review",
    description: "Review",
    source: "project",
    builtin: false,
  },
  {
    name: "plan",
    description: "Plan",
    source: "global",
    builtin: false,
  },
];

describe("slash command picker ordering", () => {
  it("uses the grouped presentation order as the selection order", () => {
    expect(
      orderSlashCommandsForPicker(commands).map(({ name }) => name),
    ).toEqual(["review", "plan", "help", "skill:smoke"]);
  });

  it("groups the ordered commands without dropping or duplicating them", () => {
    expect(
      groupSlashCommandsForPicker(commands).map(({ label, commands }) => ({
        label,
        commands: commands.map(({ name }) => name),
      })),
    ).toEqual([
      { label: "Project", commands: ["review"] },
      { label: "Global", commands: ["plan"] },
      { label: "Built-in", commands: ["help"] },
      { label: "Skills", commands: ["skill:smoke"] },
    ]);
  });
});
