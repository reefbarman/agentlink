export function normalizeSkillToolNames(
  tools: readonly string[] | undefined,
): string[] | undefined {
  return tools === undefined
    ? undefined
    : [
        ...new Set(
          tools.map((tool) => (tool === "Bash" ? "execute_command" : tool)),
        ),
      ];
}
