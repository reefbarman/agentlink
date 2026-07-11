import * as vscode from "vscode";

import { DEFAULT_DIAGNOSTIC_DELAY_MS } from "../../core/capabilities/editReview.js";

export interface AgentLinkConfigurationReader {
  get<T>(section: string, defaultValue: T): T;
}

export function getDiagnosticDelay(
  configuration: AgentLinkConfigurationReader,
): number {
  return configuration.get("diagnosticDelay", DEFAULT_DIAGNOSTIC_DELAY_MS);
}

export function getMasterBypass(
  configuration: AgentLinkConfigurationReader,
): boolean {
  return configuration.get("masterBypass", false);
}

export function getConfiguredDiagnosticDelay(): number {
  return getDiagnosticDelay(vscode.workspace.getConfiguration("agentlink"));
}

export function getConfiguredMasterBypass(): boolean {
  return getMasterBypass(vscode.workspace.getConfiguration("agentlink"));
}
