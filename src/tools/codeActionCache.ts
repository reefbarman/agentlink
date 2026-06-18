import * as vscode from "vscode";

export interface CachedCodeActions {
  path: string;
  line: number;
  column: number;
  actions: vscode.CodeAction[];
}

const cachedActionsPerSession = new Map<string, CachedCodeActions>();

export function getCachedCodeActions(
  sessionId: string,
): CachedCodeActions | null {
  return cachedActionsPerSession.get(sessionId) ?? null;
}

export function setCachedCodeActions(
  sessionId: string,
  cachedActions: CachedCodeActions,
): void {
  cachedActionsPerSession.set(sessionId, cachedActions);
}

export function clearCachedCodeActions(sessionId: string): void {
  cachedActionsPerSession.delete(sessionId);
}
