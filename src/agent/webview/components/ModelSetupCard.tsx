import type {
  ModelSetupModel,
  ModelSetupState,
} from "@agentlink/protocol/model-setup";

export type ModelSetupAction =
  | "codex"
  | "openai-api-key"
  | "openai-compatible-api-key"
  | "anthropic-api-key"
  | "configure-provider";

function setupActionFor(model: ModelSetupModel): ModelSetupAction | undefined {
  switch (model.authAction?.kind) {
    case "oauth":
      return "codex";
    case "configure_provider":
      return "configure-provider";
    case "api_key":
      return model.provider === "anthropic"
        ? "anthropic-api-key"
        : model.provider.startsWith("openai-compatible:")
          ? "openai-compatible-api-key"
          : undefined;
  }
  if (model.readiness?.status !== "credentials_required") return undefined;
  return model.provider === "anthropic"
    ? "anthropic-api-key"
    : model.provider.startsWith("openai-compatible:")
      ? "openai-compatible-api-key"
      : "codex";
}

interface ModelSetupCardProps {
  setupState: ModelSetupState;
  hasWorkspace: boolean;
  surface: "vscode" | "browser";
  onSetupAction?: (action: ModelSetupAction, provider?: string) => void;
  onOpenFolder?: () => void;
}

function providerLabel(model: ModelSetupModel): string {
  return model.providerDisplayName ?? model.provider;
}

export function ModelSetupCard({
  setupState,
  hasWorkspace,
  surface,
  onSetupAction,
  onOpenFolder,
}: ModelSetupCardProps) {
  if (setupState.kind === "checking") {
    return (
      <div class="model-setup-card" role="status">
        <i class="codicon codicon-loading model-setup-card-icon" />
        <div>
          <strong>Checking model setup</strong>
          <p>Loading the available models and credential status.</p>
        </div>
      </div>
    );
  }

  if (setupState.kind === "model_unavailable") {
    return (
      <div class="model-setup-card" role="status">
        <i class="codicon codicon-warning model-setup-card-icon" />
        <div>
          <strong>Selected model is unavailable</strong>
          <p>{setupState.reason ?? "Choose another model to start a chat."}</p>
        </div>
      </div>
    );
  }

  if (setupState.kind === "ready") {
    return (
      <div class="model-setup-card model-setup-card-ready">
        <i class="codicon codicon-pass-filled model-setup-card-icon" />
        <div>
          <strong>Ready to start</strong>
          <p>
            {setupState.model.displayName} is ready to try. Credentials are
            configured.
          </p>
          {hasWorkspace ? (
            <p class="model-setup-card-guide">
              Try: “Explain this project” or “Help me make a change.”
            </p>
          ) : (
            <p class="model-setup-card-guide">
              Ask questions here, or open a folder to let AgentLink work with a
              project.
            </p>
          )}
        </div>
        {!hasWorkspace && surface === "vscode" && onOpenFolder && (
          <button
            class="model-setup-card-secondary-action"
            type="button"
            onClick={onOpenFolder}
          >
            Open Folder
          </button>
        )}
      </div>
    );
  }

  const primaryAction = setupActionFor(setupState.model);
  const primaryLabel =
    primaryAction === "anthropic-api-key"
      ? "Use Anthropic API key"
      : primaryAction === "openai-api-key" ||
          primaryAction === "openai-compatible-api-key"
        ? "Add API key"
        : primaryAction === "configure-provider"
          ? "Configure provider"
          : "Continue with ChatGPT/Codex";
  const browserMessage =
    "Finish model setup in the AgentLink VS Code window. Credentials stay on that host.";

  return (
    <div class="model-setup-card model-setup-card-required">
      <i class="codicon codicon-key model-setup-card-icon" />
      <div>
        <strong>Set up AgentLink</strong>
        <p>
          {surface === "browser"
            ? browserMessage
            : `${providerLabel(setupState.model)} needs credentials before it can respond.`}
        </p>
        {surface === "vscode" && onSetupAction && primaryAction && (
          <div class="model-setup-card-actions">
            <button
              class="model-setup-card-primary-action"
              type="button"
              onClick={() =>
                onSetupAction(primaryAction, setupState.model.provider)
              }
            >
              {primaryLabel}
            </button>
            {primaryAction === "codex" && (
              <button
                class="model-setup-card-secondary-action"
                type="button"
                onClick={() => onSetupAction("openai-api-key")}
              >
                Use OpenAI API key
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
