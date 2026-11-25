import * as vscode from "vscode";

export interface SemanticEmbeddingCommandDependencies {
  hasApiKey(): Promise<boolean>;
  /** Chunks in the current index, for sizing the request to OpenAI. */
  getChunkCount(): number | undefined;
  /** The bundled documentation page. */
  helpUri: vscode.Uri;
  onChanged(): void;
}

const SETTING = "semanticEmbeddingsEnabled";
/** Average indexed chunk, about 1,080 characters at four per token. */
const APPROXIMATE_TOKENS_PER_CHUNK = 270;

export function registerSemanticEmbeddingCommands(
  dependencies: SemanticEmbeddingCommandDependencies,
): vscode.Disposable[] {
  const openHelp = () =>
    vscode.commands.executeCommand(
      "markdown.showPreview",
      dependencies.helpUri,
    );
  return [
    vscode.commands.registerCommand(
      "agentlink.openSemanticEmbeddingsHelp",
      openHelp,
    ),
    vscode.commands.registerCommand("agentlink.enableSemanticEmbeddings", () =>
      enableSemanticEmbeddings(dependencies, openHelp),
    ),
    vscode.commands.registerCommand("agentlink.disableSemanticEmbeddings", () =>
      disableSemanticEmbeddings(dependencies),
    ),
  ];
}

async function enableSemanticEmbeddings(
  dependencies: SemanticEmbeddingCommandDependencies,
  openHelp: () => Thenable<unknown>,
): Promise<void> {
  if (
    !vscode.workspace
      .getConfiguration("agentlink")
      .get<boolean>("semanticSearchEnabled", true)
  ) {
    void vscode.window.showInformationMessage(
      "Turn on agentlink.semanticSearchEnabled and reload the window before turning on semantic search embeddings.",
    );
    return;
  }

  const consent = await vscode.window.showWarningMessage(
    "Turn on semantic search?",
    { modal: true, detail: consentDetail(dependencies.getChunkCount()) },
    "Choose Where",
    "Learn More",
  );
  if (consent === "Learn More") {
    await openHelp();
    return;
  }
  if (consent !== "Choose Where") return;

  const scope = await vscode.window.showQuickPick(
    [
      ...(vscode.workspace.workspaceFolders?.length
        ? [
            {
              label: "This workspace only",
              description:
                "Saved in workspace settings, which may be shared through source control",
              value: "workspace",
            },
          ]
        : []),
      {
        label: "All workspaces",
        description:
          "Saved in your user settings. Every project you open sends its indexed code to OpenAI",
        value: "user",
      },
    ],
    { title: "Where should semantic search be on?", ignoreFocusOut: true },
  );
  if (!scope) return;

  // Get the key first, so cancelling never leaves the setting on.
  if (!(await dependencies.hasApiKey())) {
    await vscode.commands.executeCommand("agentlink.setOpenaiApiKey");
    if (!(await dependencies.hasApiKey())) {
      void vscode.window.showInformationMessage(
        "Semantic search was not turned on because no OpenAI API key is set.",
      );
      return;
    }
  }

  await vscode.workspace
    .getConfiguration("agentlink")
    .update(
      SETTING,
      true,
      scope.value === "workspace"
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global,
    );
  dependencies.onChanged();

  // Unchanged files keep their existing entries, so only a rebuild embeds them.
  const rebuild = await vscode.window.showInformationMessage(
    "Semantic search is on. Code that is already indexed needs a rebuild to get embeddings.",
    "Rebuild Index",
    "Later",
  );
  if (rebuild === "Rebuild Index") {
    await vscode.commands.executeCommand("agentlink.rebuildIndex");
  }
}

function consentDetail(chunkCount: number | undefined): string {
  const size = chunkCount
    ? ` This workspace has ${chunkCount.toLocaleString("en-US")} chunks, roughly ${formatTokens(chunkCount * APPROXIMATE_TOKENS_PER_CHUNK)} tokens.`
    : "";
  return [
    "AgentLink will send indexed source code and search queries to OpenAI to create embeddings. Files excluded from the index are not sent.",
    `OpenAI bills your API key for usage.${size} After that, only changed files and searches are sent.`,
    "The index stays on this machine. You can turn this off at any time.",
  ].join("\n\n");
}

function formatTokens(tokens: number): string {
  return tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)} million`
    : `${Math.max(1, Math.round(tokens / 1_000))} thousand`;
}

async function disableSemanticEmbeddings(
  dependencies: SemanticEmbeddingCommandDependencies,
): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("agentlink");
  const inspected = configuration.inspect<boolean>(SETTING);
  if (inspected?.workspaceValue) {
    await configuration.update(
      SETTING,
      undefined,
      vscode.ConfigurationTarget.Workspace,
    );
  }
  if (inspected?.globalValue) {
    await configuration.update(
      SETTING,
      undefined,
      vscode.ConfigurationTarget.Global,
    );
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const folderConfiguration = vscode.workspace.getConfiguration(
      "agentlink",
      folder.uri,
    );
    if (folderConfiguration.inspect<boolean>(SETTING)?.workspaceFolderValue) {
      await folderConfiguration.update(
        SETTING,
        undefined,
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
    }
  }
  dependencies.onChanged();
  void vscode.window.showInformationMessage(
    inspected?.globalValue
      ? "Semantic search is off in all workspaces that did not turn it on themselves. Existing embeddings stay on this machine."
      : "Semantic search is off. Existing embeddings stay on this machine.",
  );
}
