import * as vscode from "vscode";

import { resolveCurrentDiff, showDiffMoreOptions } from "./DiffViewProvider.js";

export function registerDiffViewCommands(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("agentlink.acceptDiff", () =>
      resolveCurrentDiff("accept"),
    ),
    vscode.commands.registerCommand("agentlink.acceptDiffMore", () =>
      showDiffMoreOptions(),
    ),
    vscode.commands.registerCommand("agentlink.rejectDiff", () =>
      resolveCurrentDiff("reject"),
    ),
  ];
}
