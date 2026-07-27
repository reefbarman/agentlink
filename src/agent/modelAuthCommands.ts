import * as vscode from "vscode";

import type { SemanticReadinessReason } from "../shared/semanticReadiness.js";

interface OpenAiApiKeyStore {
  storeApiKey(
    key: string,
    scope: "embeddings-only" | "models+embeddings",
  ): Promise<void>;
}

interface SecretStore {
  store(key: string, value: string): Thenable<void>;
}

export interface ModelAuthCommandDependencies {
  openAiAuthManager: OpenAiApiKeyStore;
  secrets: SecretStore;
  setAnthropicApiKey(key: string): void;
  refreshModels(): void;
  publishBrowserModelCatalog(): void | Promise<void>;
  grantBrowserModelCredentials(): void | Promise<void>;
}

export function getSemanticSetupTitle(
  reason?: SemanticReadinessReason,
): string {
  switch (reason) {
    case "missing_embeddings_auth":
      return "Improve semantic search with vector ranking";
    case "missing_index":
      return "Set up semantic search: build codebase index";
    case "store_unavailable":
      return "Semantic search unavailable: retrieval store is not ready";
    case "disabled":
      return "Semantic search is disabled";
    case "no_workspace":
      return "Semantic search requires an open workspace";
    default:
      return "Set up semantic search";
  }
}

export function getSemanticSetupDetail(
  reason?: SemanticReadinessReason,
): string {
  switch (reason) {
    case "missing_embeddings_auth":
      return "Lexical indexing and search work without credentials. Configure an OpenAI API key to add vector and hybrid ranking.";
    case "missing_index":
      return "This workspace has not been indexed yet. Lexical indexing works without embedding credentials.";
    case "store_unavailable":
      return "The embedded retrieval store must be available before semantic indexing and search can run.";
    case "disabled":
      return "Enable agentlink.semanticSearchEnabled in settings to use semantic indexing and search.";
    case "no_workspace":
      return "Open a workspace folder to build and query a semantic codebase index.";
    default:
      return "Semantic search requires setup before it can run.";
  }
}

export function registerModelAuthCommands({
  openAiAuthManager,
  secrets,
  setAnthropicApiKey,
  refreshModels,
  publishBrowserModelCatalog,
  grantBrowserModelCredentials,
}: ModelAuthCommandDependencies): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("agentlink.setOpenaiApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "OpenAI API Key (Embeddings)",
        prompt:
          "Enter your OpenAI API key for semantic search and indexing embeddings. This command stores an embeddings-only key and does not replace ChatGPT/Codex OAuth model auth.",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim() ? null : "API key cannot be empty",
      });
      if (!key) return;
      await openAiAuthManager.storeApiKey(key.trim(), "embeddings-only");
      vscode.window.showInformationMessage(
        "OpenAI API key stored securely for embeddings (semantic search/indexing).",
      );
    }),
    vscode.commands.registerCommand(
      "agentlink.setupSemanticSearch",
      async (reason?: SemanticReadinessReason) => {
        const action = await vscode.window.showQuickPick(
          [
            {
              label: "Set OpenAI API key for embeddings only",
              description:
                "Optional: add vector and hybrid ranking when model chat already uses OAuth",
              value: "embeddingsKey",
            },
            {
              label: "Set OpenAI API key for models + embeddings",
              description:
                "Use one API key for model chat and optional vector/hybrid ranking",
              value: "modelsAndEmbeddingsKey",
            },
            {
              label: "Sign in with ChatGPT/Codex (OAuth)",
              description:
                "Model-chat auth only; lexical codebase retrieval remains available",
              value: "oauth",
            },
            {
              label: "Build/Rebuild codebase index",
              description:
                "Build the lexical index now; embeddings are optional",
              value: "rebuild",
            },
            {
              label: "Open AgentLink settings",
              value: "settings",
            },
          ],
          {
            title: getSemanticSetupTitle(reason),
            placeHolder: getSemanticSetupDetail(reason),
            ignoreFocusOut: true,
          },
        );

        if (!action) return;

        if (action.value === "embeddingsKey") {
          await vscode.commands.executeCommand("agentlink.setOpenaiApiKey");
          const start = await vscode.window.showInformationMessage(
            "Embeddings key configured. Start indexing now?",
            "Index Codebase",
          );
          if (start === "Index Codebase") {
            await vscode.commands.executeCommand("agentlink.rebuildIndex");
          }
          return;
        }

        if (action.value === "modelsAndEmbeddingsKey") {
          const key = await vscode.window.showInputBox({
            title: "OpenAI API Key",
            prompt:
              "Enter your OpenAI API key for models and embeddings. OAuth remains preferred for model chat if also configured.",
            password: true,
            ignoreFocusOut: true,
            validateInput: (value) =>
              value.trim() ? null : "API key cannot be empty",
          });
          if (!key) return;
          await openAiAuthManager.storeApiKey(key.trim(), "models+embeddings");
          vscode.window.showInformationMessage(
            "OpenAI API key stored securely for models and embeddings.",
          );
          const start = await vscode.window.showInformationMessage(
            "API key configured. Start indexing now?",
            "Index Codebase",
          );
          if (start === "Index Codebase") {
            await vscode.commands.executeCommand("agentlink.rebuildIndex");
          }
          return;
        }

        if (action.value === "oauth") {
          await vscode.commands.executeCommand("agentlink.codexSignIn");
          return;
        }

        if (action.value === "rebuild") {
          await vscode.commands.executeCommand("agentlink.rebuildIndex");
          return;
        }

        if (action.value === "settings") {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "agentlink",
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.setAnthropicApiKey",
      async () => {
        const key = await vscode.window.showInputBox({
          title: "Anthropic API Key",
          prompt:
            "Get your API key at https://platform.claude.com/settings/keys — or set ANTHROPIC_API_KEY as an environment variable instead",
          password: true,
          ignoreFocusOut: true,
          validateInput: (value) =>
            value.trim() ? null : "API key cannot be empty",
        });
        if (!key) return;
        const trimmedKey = key.trim();
        await secrets.store("anthropicApiKey", trimmedKey);
        setAnthropicApiKey(trimmedKey);
        refreshModels();
        void publishBrowserModelCatalog();
        void grantBrowserModelCredentials();
        vscode.window.showInformationMessage(
          "Anthropic API key stored securely.",
        );
      },
    ),
  ];
}
