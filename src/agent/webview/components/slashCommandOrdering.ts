import type { ChatSlashCommandInfo as SlashCommandInfo } from "@agentlink/protocol/chat-catalog";

export const SLASH_COMMAND_SECTIONS: ReadonlyArray<{
  source: SlashCommandInfo["source"];
  label: string;
}> = [
  { source: "project", label: "Project" },
  { source: "global", label: "Global" },
  { source: "agentlink", label: "AgentLink" },
  { source: "builtin", label: "Built-in" },
  { source: "skill", label: "Skills" },
];

/**
 * Keeps keyboard selection aligned with the grouped order shown in the picker.
 * Built-ins are grouped together even when their source metadata differs.
 */
export function orderSlashCommandsForPicker(
  commands: readonly SlashCommandInfo[],
): SlashCommandInfo[] {
  const builtins = commands.filter((command) => command.builtin);
  const nonBuiltins = commands.filter((command) => !command.builtin);

  return SLASH_COMMAND_SECTIONS.flatMap(({ source }) => {
    if (source === "builtin") return builtins;
    return nonBuiltins.filter((command) => command.source === source);
  });
}

export function groupSlashCommandsForPicker(
  commands: readonly SlashCommandInfo[],
): Array<{ label: string; commands: SlashCommandInfo[] }> {
  const orderedCommands = orderSlashCommandsForPicker(commands);
  const groups: Array<{ label: string; commands: SlashCommandInfo[] }> = [];
  let offset = 0;

  for (const { source, label } of SLASH_COMMAND_SECTIONS) {
    const group = orderedCommands
      .slice(offset)
      .filter((command) =>
        source === "builtin" ? command.builtin : command.source === source,
      );
    if (group.length > 0) {
      groups.push({ label, commands: group });
      offset += group.length;
    }
  }

  return groups;
}
