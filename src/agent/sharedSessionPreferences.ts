import * as vscode from "vscode";

/** Picker defaults are user-scoped, never shadowed by an old workspace preference. */
export function getUserSessionPreference<T>(
  config: vscode.WorkspaceConfiguration,
  key: string,
): T | undefined {
  if (!config.inspect) return config.get<T>(key);
  const inspected = config.inspect<T>(key);
  const defaults = inspected?.defaultValue;
  const saved = inspected?.globalValue;
  if (
    defaults &&
    saved &&
    typeof defaults === "object" &&
    typeof saved === "object" &&
    !Array.isArray(defaults) &&
    !Array.isArray(saved)
  ) {
    return { ...defaults, ...saved };
  }
  return saved ?? defaults;
}

export function getNewSessionMode(fallback = "code"): string {
  return (
    getUserSessionPreference<string>(
      vscode.workspace.getConfiguration("agentlink"),
      "defaultMode",
    )?.trim() || fallback
  );
}

export async function rememberSessionMode(mode: string): Promise<void> {
  await vscode.workspace
    .getConfiguration("agentlink")
    .update("defaultMode", mode, vscode.ConfigurationTarget.Global);
}
