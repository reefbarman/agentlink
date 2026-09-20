import * as vscode from "vscode";

import { TYPESAFE_GUARDIAN_API_KEY_SECRET } from "./typeSafeGuardianShadow.js";

export interface TypeSafeGuardianCommandDependencies {
  secrets: Pick<vscode.SecretStorage, "store" | "delete">;
}

export function registerTypeSafeGuardianCommands(
  dependencies: TypeSafeGuardianCommandDependencies,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      "agentlink.setTypeSafeGuardianApiKey",
      async () => {
        const value = await vscode.window.showInputBox({
          title: "TypeSafe API key for Guardian shadow mode",
          prompt:
            "Stored in VS Code SecretStorage. When shadow mode is enabled, bounded command-review evidence is sent to TypeSafe for evaluation but never affects approval decisions.",
          password: true,
          ignoreFocusOut: true,
          validateInput: (input) =>
            input.trim() ? null : "API key cannot be empty",
        });
        if (!value) return;
        await dependencies.secrets.store(
          TYPESAFE_GUARDIAN_API_KEY_SECRET,
          value.trim(),
        );
        void vscode.window.showInformationMessage(
          "TypeSafe Guardian shadow API key stored securely.",
        );
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.clearTypeSafeGuardianApiKey",
      async () => {
        await dependencies.secrets.delete(TYPESAFE_GUARDIAN_API_KEY_SECRET);
        void vscode.window.showInformationMessage(
          "TypeSafe Guardian shadow API key cleared.",
        );
      },
    ),
  ];
}
