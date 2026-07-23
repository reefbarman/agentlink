import * as vscode from "vscode";

import {
  OpenAiCompatibleCredentialService,
  type OpenAiCompatibleKeyNameState,
  type OpenAiCompatibleSecretStore,
  normalizeOpenAiCompatibleApiKeyName,
} from "./openAiCompatibleCredentials.js";

export { OPENAI_COMPATIBLE_KEY_INDEX_STATE } from "./openAiCompatibleCredentials.js";
export { OPENAI_COMPATIBLE_SECRET_PREFIX } from "./openAiCompatibleSecrets.js";

export interface OpenAiCompatibleAuthCommandDependencies {
  secrets: OpenAiCompatibleSecretStore;
  state: OpenAiCompatibleKeyNameState;
  getConfiguredAuthKeys(): readonly string[];
  onCredentialChanged(authKey: string): void | Promise<void>;
}

interface AuthKeyPick extends vscode.QuickPickItem {
  authKey?: string;
  manual?: boolean;
}

async function enterAuthKeyName(): Promise<string | undefined> {
  const manual = await vscode.window.showInputBox({
    title: "OpenAI-compatible API key name",
    prompt:
      "Enter one non-secret name. Use this same value as the connection's authKey setting.",
    placeHolder: "For example: openrouter-main",
    ignoreFocusOut: true,
    validateInput: (value) =>
      normalizeOpenAiCompatibleApiKeyName(value)
        ? null
        : "Use lowercase letters, digits, dots, underscores, or hyphens.",
  });
  return manual ? normalizeOpenAiCompatibleApiKeyName(manual) : undefined;
}

async function chooseAuthKey(
  credentials: OpenAiCompatibleCredentialService,
  title: string,
  preferredAuthKey?: string,
): Promise<string | undefined> {
  const preferred = preferredAuthKey
    ? normalizeOpenAiCompatibleApiKeyName(preferredAuthKey)
    : undefined;
  if (preferred) return preferred;

  const knownAuthKeys = credentials.getApiKeyNames();
  if (knownAuthKeys.length === 0) return enterAuthKeyName();

  const options: AuthKeyPick[] = [
    ...knownAuthKeys.map((authKey) => ({
      label: authKey,
      authKey,
    })),
    {
      label: "$(add) Enter another key name…",
      description: "Add a name not listed above",
      alwaysShow: true,
      manual: true,
    },
  ];
  const selected = await vscode.window.showQuickPick(options, {
    title,
    placeHolder: "Select an API key name",
    ignoreFocusOut: true,
  });
  if (!selected) return undefined;
  if (selected.authKey) return selected.authKey;
  if (!selected.manual) return undefined;
  return enterAuthKeyName();
}

export function registerOpenAiCompatibleAuthCommands(
  dependencies: OpenAiCompatibleAuthCommandDependencies,
): vscode.Disposable[] {
  const credentials = new OpenAiCompatibleCredentialService({
    secrets: dependencies.secrets,
    state: dependencies.state,
    getConfiguredApiKeyNames: dependencies.getConfiguredAuthKeys,
  });

  return [
    vscode.commands.registerCommand(
      "agentlink.setOpenAiCompatibleApiKey",
      async (preferredAuthKey?: string) => {
        const authKey = await chooseAuthKey(
          credentials,
          "Set OpenAI-compatible API key",
          preferredAuthKey,
        );
        if (!authKey) return;
        const value = await vscode.window.showInputBox({
          title: `API key: ${authKey}`,
          prompt:
            "The key is stored in VS Code SecretStorage and is never written to settings.",
          password: true,
          ignoreFocusOut: true,
          validateInput: (input) =>
            input.trim() ? null : "API key cannot be empty",
        });
        if (!value) return;
        await credentials.storeCredential(authKey, value);
        await credentials.setCredentialIndexed(authKey, true);
        await dependencies.onCredentialChanged(authKey);
        void vscode.window.showInformationMessage(
          `OpenAI-compatible API key “${authKey}” stored securely.`,
        );
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.clearOpenAiCompatibleApiKey",
      async (preferredAuthKey?: string) => {
        const authKey = await chooseAuthKey(
          credentials,
          "Clear OpenAI-compatible API key",
          preferredAuthKey,
        );
        if (!authKey) return;
        await credentials.deleteCredential(authKey);
        await credentials.setCredentialIndexed(authKey, false);
        await dependencies.onCredentialChanged(authKey);
        void vscode.window.showInformationMessage(
          `OpenAI-compatible API key “${authKey}” cleared.`,
        );
      },
    ),
  ];
}
