export interface AgentPluginPlaceholderValues {
  readonly pluginRoot: string;
  readonly pluginData: string;
}

const PLACEHOLDER_PATTERN = /\$\{PLUGIN_(ROOT|DATA)\}/gu;

/** Replaces every supported placeholder in one non-recursive textual pass. */
export function expandAgentPluginPlaceholders(
  value: string,
  replacements: Readonly<AgentPluginPlaceholderValues>,
): string {
  return value.replace(PLACEHOLDER_PATTERN, (_match, kind: "ROOT" | "DATA") =>
    kind === "ROOT" ? replacements.pluginRoot : replacements.pluginData,
  );
}

export function expandAgentPluginStringArray(
  values: readonly string[],
  replacements: Readonly<AgentPluginPlaceholderValues>,
): string[] {
  return values.map((value) =>
    expandAgentPluginPlaceholders(value, replacements),
  );
}

export function expandAgentPluginEnvironment(
  values: Readonly<Record<string, string>>,
  replacements: Readonly<AgentPluginPlaceholderValues>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      expandAgentPluginPlaceholders(value, replacements),
    ]),
  );
}
