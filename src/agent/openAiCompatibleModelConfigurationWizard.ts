import * as vscode from "vscode";

import type { CoreReasoningEffort } from "../core/modelCatalog.js";
import type { OpenAiCompatibleProfileKind } from "../core/model/providers/openaiCompatible/types.js";
import {
  OpenAiCompatibleCredentialService,
  normalizeOpenAiCompatibleApiKeyName,
  type StagedOpenAiCompatibleCredential,
  type StoredOpenAiCompatibleCredential,
} from "./openAiCompatibleCredentials.js";
import {
  type OpenAiCompatibleConnectionDto,
  type OpenAiCompatibleModelDto,
  type NormalizeOpenAiCompatibleConnectionsResult,
  validateOpenAiCompatibleBaseUrl,
} from "./providers/openaiCompatible/config.js";
import {
  type DiscoveredOpenAiCompatibleModel,
  discoverOpenAiCompatibleModels,
} from "./providers/openaiCompatible/modelDiscovery.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const REASONING_EFFORTS: CoreReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

interface ServicePick extends vscode.QuickPickItem {
  profile: OpenAiCompatibleProfileKind;
}

interface CredentialPick extends vscode.QuickPickItem {
  apiKeyName?: string;
  action?: "create" | "none";
  missing?: boolean;
}

interface ModelPick extends vscode.QuickPickItem {
  model?: DiscoveredOpenAiCompatibleModel;
  manual?: boolean;
}

interface CapabilityPick extends vscode.QuickPickItem {
  capability: "tools" | "thinking" | "images";
}

interface ReasoningPick extends vscode.QuickPickItem {
  effort: CoreReasoningEffort;
}

interface SelectedCredential {
  apiKeyName?: string;
  apiKeyValue?: string;
  staged?: StagedOpenAiCompatibleCredential;
}

interface ModelDraft extends OpenAiCompatibleModelDto {
  provenance: DiscoveredOpenAiCompatibleModel["provenance"];
}

export interface OpenAiCompatibleWizardRefreshResult {
  applied: boolean;
  issues?: readonly { path: string; message: string }[];
}

export interface OpenAiCompatibleModelConfigurationWizardDependencies {
  credentials: OpenAiCompatibleCredentialService;
  getGlobalConnections(): unknown;
  updateGlobalConnections(value: unknown): Promise<void>;
  validateConnections(raw: unknown): NormalizeOpenAiCompatibleConnectionsResult;
  getReservedModelIds(): readonly string[];
  refreshProviders(): Promise<OpenAiCompatibleWizardRefreshResult>;
  discoverModels?: typeof discoverOpenAiCompatibleModels;
  openSettings(): void | Promise<void>;
  log?: (message: string) => void;
}

export function registerOpenAiCompatibleModelConfigurationWizard(
  dependencies: OpenAiCompatibleModelConfigurationWizardDependencies,
): vscode.Disposable {
  let running = false;
  return vscode.commands.registerCommand(
    "agentlink.configureOpenAiCompatibleModel",
    async () => {
      if (running) {
        void vscode.window.showInformationMessage(
          "OpenAI-compatible model configuration is already in progress.",
        );
        return;
      }
      running = true;
      try {
        await configureOpenAiCompatibleModel(dependencies);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dependencies.log?.(`[openai-compatible-wizard] ${message}`);
        void vscode.window.showErrorMessage(
          `Could not configure the OpenAI-compatible model: ${message}`,
        );
      } finally {
        running = false;
      }
    },
  );
}

export async function configureOpenAiCompatibleModel(
  dependencies: OpenAiCompatibleModelConfigurationWizardDependencies,
): Promise<void> {
  const initial = dependencies.getGlobalConnections();
  if (!(await requireValidExistingConfiguration(initial, dependencies))) return;

  const service = await chooseService();
  if (!service) return;
  const baseUrl = await chooseBaseUrl(service.profile);
  if (!baseUrl) return;
  const validatedBaseUrl = validateOpenAiCompatibleBaseUrl(baseUrl);
  if (!validatedBaseUrl.baseUrl) {
    void vscode.window.showErrorMessage(
      validatedBaseUrl.issues[0]?.message ?? "Invalid API base URL.",
    );
    return;
  }

  const credential = await chooseCredential(
    dependencies.credentials,
    service.profile,
  );
  if (!credential) return;

  let allowInsecureHttp = false;
  if (
    credential.apiKeyName &&
    validatedBaseUrl.protocol === "http:" &&
    !validatedBaseUrl.loopback
  ) {
    const confirmed = await vscode.window.showWarningMessage(
      "This API key will be sent over insecure non-loopback HTTP. HTTPS or loopback HTTP is strongly recommended.",
      { modal: true },
      "Allow Insecure HTTP",
    );
    if (confirmed !== "Allow Insecure HTTP") return;
    allowInsecureHttp = true;
  }

  const discovered = await discoverOrChooseManual({
    baseUrl: validatedBaseUrl.baseUrl,
    profile: service.profile,
    apiKey: credential.apiKeyValue,
    discover: dependencies.discoverModels ?? discoverOpenAiCompatibleModels,
  });
  if (!discovered) return;

  const displayName = await vscode.window.showInputBox({
    title: "Model display name",
    prompt: "Name shown in AgentLink's model selector.",
    value: discovered.displayName,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() ? null : "Model display name cannot be empty.",
  });
  if (!displayName) return;

  let draft: ModelDraft = {
    id: "pending",
    model: discovered.model,
    displayName: displayName.trim(),
    contextWindow: discovered.contextWindow,
    maxOutputTokens: discovered.maxOutputTokens,
    supportsToolUse: discovered.supportsToolUse,
    supportsThinking: discovered.supportsThinking,
    supportsImages: discovered.supportsImages,
    ...(discovered.reasoningEfforts
      ? { reasoningEfforts: discovered.reasoningEfforts }
      : {}),
    ...(discovered.defaultReasoningEffort
      ? { defaultReasoningEffort: discovered.defaultReasoningEffort }
      : {}),
    provenance: discovered.provenance,
  };

  while (true) {
    const review = await reviewModelDraft(draft, {
      profile: service.profile,
      baseUrl: validatedBaseUrl.baseUrl,
      apiKeyName: credential.apiKeyName,
    });
    if (!review) return;
    if (review === "edit") {
      const edited = await editModelDraft(draft, service.profile);
      if (!edited) return;
      draft = edited;
      continue;
    }
    break;
  }

  await commitWizardConfiguration({
    dependencies,
    initial,
    service,
    baseUrl: validatedBaseUrl.baseUrl,
    allowInsecureHttp,
    credential,
    draft,
  });
}

async function requireValidExistingConfiguration(
  raw: unknown,
  dependencies: OpenAiCompatibleModelConfigurationWizardDependencies,
): Promise<boolean> {
  const result = dependencies.validateConnections(raw);
  if (Array.isArray(raw) && result.issues.length === 0) return true;
  const choice = await vscode.window.showErrorMessage(
    "The existing OpenAI-compatible connection setting is invalid. Fix it before adding a model.",
    "Open Settings",
  );
  if (choice === "Open Settings") await dependencies.openSettings();
  return false;
}

async function chooseService(): Promise<ServicePick | undefined> {
  return vscode.window.showQuickPick<ServicePick>(
    [
      {
        label: "OpenRouter",
        description: "Discover rich model metadata from OpenRouter",
        profile: "openrouter",
      },
      {
        label: "Other OpenAI-compatible endpoint",
        description: "Discover model IDs or enter one manually",
        profile: "generic",
      },
    ],
    {
      title: "Configure OpenAI-compatible model",
      placeHolder: "Choose the service that hosts this model",
      ignoreFocusOut: true,
    },
  );
}

async function chooseBaseUrl(
  profile: OpenAiCompatibleProfileKind,
): Promise<string | undefined> {
  if (profile === "openrouter") return OPENROUTER_BASE_URL;
  return vscode.window.showInputBox({
    title: "OpenAI-compatible API base URL",
    prompt:
      "Enter the API root. AgentLink appends /models and /chat/completions.",
    placeHolder: "http://127.0.0.1:1234/v1",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const result = validateOpenAiCompatibleBaseUrl(value);
      return result.baseUrl
        ? null
        : (result.issues[0]?.message ?? "Invalid URL.");
    },
  });
}

async function chooseCredential(
  credentials: OpenAiCompatibleCredentialService,
  profile: OpenAiCompatibleProfileKind,
): Promise<SelectedCredential | undefined> {
  const statuses = await credentials.getCredentialStatuses();
  const options: CredentialPick[] = [
    ...statuses.map((entry) => ({
      label: entry.apiKeyName,
      description:
        entry.status === "stored" ? "Stored securely" : "Missing API key value",
      apiKeyName: entry.apiKeyName,
      missing: entry.status === "missing",
    })),
    {
      label: "$(add) Create a new API key…",
      description: "Choose a name, then enter the secret value",
      action: "create",
      alwaysShow: true,
    },
    ...(profile === "generic"
      ? [
          {
            label: "$(circle-slash) No API key",
            description: "For a local or otherwise unauthenticated endpoint",
            action: "none" as const,
          },
        ]
      : []),
  ];
  const selected = await vscode.window.showQuickPick(options, {
    title: "API key",
    placeHolder: "Select an existing API key or create one",
    ignoreFocusOut: true,
  });
  if (!selected) return undefined;
  if (selected.action === "none") return {};
  if (selected.action === "create") return createCredential(credentials);
  if (!selected.apiKeyName) return undefined;

  const stored = await credentials.getCredentialValue(selected.apiKeyName);
  if (stored) {
    return { apiKeyName: selected.apiKeyName, apiKeyValue: stored };
  }
  return enterMissingCredential(credentials, selected.apiKeyName);
}

async function createCredential(
  credentials: OpenAiCompatibleCredentialService,
): Promise<SelectedCredential | undefined> {
  const apiKeyName = await vscode.window.showInputBox({
    title: "New API key name",
    prompt:
      "Enter one non-secret name. Models can reuse this name without duplicating the secret.",
    placeHolder: "For example: openrouter-main",
    ignoreFocusOut: true,
    validateInput: (value) =>
      normalizeOpenAiCompatibleApiKeyName(value)
        ? null
        : "Use lowercase letters, digits, dots, underscores, or hyphens.",
  });
  if (!apiKeyName) return undefined;
  const normalizedName = normalizeOpenAiCompatibleApiKeyName(apiKeyName);
  if (!normalizedName) return undefined;
  const existing = await credentials.getCredentialValue(normalizedName);
  if (existing) {
    const useExisting = await vscode.window.showWarningMessage(
      `API key “${normalizedName}” already exists. The wizard will not replace it.`,
      "Use Existing",
    );
    return useExisting === "Use Existing"
      ? { apiKeyName: normalizedName, apiKeyValue: existing }
      : undefined;
  }
  return enterMissingCredential(credentials, normalizedName);
}

async function enterMissingCredential(
  credentials: OpenAiCompatibleCredentialService,
  apiKeyName: string,
): Promise<SelectedCredential | undefined> {
  const value = await vscode.window.showInputBox({
    title: `API key: ${apiKeyName}`,
    prompt: "Stored in VS Code SecretStorage only after final confirmation.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (input) =>
      input.trim() ? null : "API key cannot be empty.",
  });
  if (!value) return undefined;
  const staged = credentials.stageCredential(apiKeyName, value);
  return {
    apiKeyName,
    apiKeyValue: credentials.getStagedCredentialValue(staged),
    staged,
  };
}

async function discoverOrChooseManual(args: {
  baseUrl: string;
  profile: OpenAiCompatibleProfileKind;
  apiKey?: string;
  discover: typeof discoverOpenAiCompatibleModels;
}): Promise<DiscoveredOpenAiCompatibleModel | undefined> {
  while (true) {
    try {
      const models = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Discovering OpenAI-compatible models…",
          cancellable: true,
        },
        async (_progress, token) => {
          const controller = new AbortController();
          const subscription = token.onCancellationRequested(() =>
            controller.abort(),
          );
          try {
            return await args.discover({
              baseUrl: args.baseUrl,
              profile: args.profile,
              apiKey: args.apiKey,
              signal: controller.signal,
            });
          } finally {
            subscription.dispose();
          }
        },
      );
      const selected = await vscode.window.showQuickPick<ModelPick>(
        [
          ...models.map((model) => ({
            label: model.displayName,
            description: model.model,
            model,
          })),
          {
            label: "$(edit) Enter model ID manually…",
            description: "Use conservative editable defaults",
            manual: true,
            alwaysShow: true,
          },
        ],
        {
          title: "Model",
          placeHolder: "Select a discovered model",
          ignoreFocusOut: true,
          matchOnDescription: true,
        },
      );
      if (!selected) return undefined;
      return selected.manual ? enterManualModel() : selected.model;
    } catch (error) {
      if (isAbortError(error)) return undefined;
      const message = error instanceof Error ? error.message : String(error);
      const choice = await vscode.window.showWarningMessage(
        `Model discovery failed: ${message}`,
        "Retry",
        "Enter Model ID Manually",
      );
      if (choice === "Retry") continue;
      if (choice === "Enter Model ID Manually") return enterManualModel();
      return undefined;
    }
  }
}

async function enterManualModel(): Promise<
  DiscoveredOpenAiCompatibleModel | undefined
> {
  const model = await vscode.window.showInputBox({
    title: "Upstream model ID",
    prompt: "Enter the exact opaque model ID expected by the endpoint.",
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() ? null : "Model ID cannot be empty.",
  });
  if (!model) return undefined;
  const normalized = model.trim();
  return {
    model: normalized,
    displayName: normalized,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    supportsToolUse: false,
    supportsThinking: false,
    supportsImages: false,
    provenance: {
      displayName: "default",
      contextWindow: "default",
      maxOutputTokens: "default",
      supportsToolUse: "default",
      supportsThinking: "default",
      supportsImages: "default",
    },
  };
}

async function reviewModelDraft(
  draft: ModelDraft,
  connection: {
    profile: OpenAiCompatibleProfileKind;
    baseUrl: string;
    apiKeyName?: string;
  },
): Promise<"save" | "edit" | undefined> {
  const defaults = Object.entries(draft.provenance)
    .filter(([, value]) => value === "default")
    .map(([key]) => key)
    .join(", ");
  const selected = await vscode.window.showQuickPick<
    vscode.QuickPickItem & { action: "save" | "edit" }
  >(
    [
      {
        label: "$(check) Save with these values",
        detail: formatDraftSummary(draft, connection, defaults),
        action: "save",
      },
      {
        label: "$(edit) Edit limits and capabilities",
        detail: defaults
          ? `Conservative defaults: ${defaults}`
          : "All displayed metadata was discovered or explicitly selected.",
        action: "edit",
      },
    ],
    {
      title: "Review OpenAI-compatible model",
      placeHolder: "Review metadata before saving",
      ignoreFocusOut: true,
    },
  );
  return selected?.action;
}

function formatDraftSummary(
  draft: ModelDraft,
  connection: {
    profile: OpenAiCompatibleProfileKind;
    baseUrl: string;
    apiKeyName?: string;
  },
  defaults: string,
): string {
  const features = [
    draft.supportsToolUse ? "tools" : "chat only",
    draft.supportsThinking ? "reasoning" : undefined,
    draft.supportsImages ? "images" : undefined,
  ].filter(Boolean);
  return [
    `${draft.displayName} (${draft.model})`,
    `${connection.profile}: ${connection.baseUrl}`,
    `API key: ${connection.apiKeyName ?? "none"}`,
    `Context ${draft.contextWindow}; output ${draft.maxOutputTokens}; ${features.join(", ")}`,
    ...(defaults ? [`Editable defaults: ${defaults}`] : []),
  ].join(" — ");
}

async function editModelDraft(
  draft: ModelDraft,
  profile: OpenAiCompatibleProfileKind,
): Promise<ModelDraft | undefined> {
  const contextWindow = await askPositiveInteger(
    "Context window",
    draft.contextWindow,
  );
  if (!contextWindow) return undefined;
  const maxOutputTokens = await askPositiveInteger(
    "Maximum output tokens",
    Math.min(draft.maxOutputTokens, contextWindow),
    contextWindow,
  );
  if (!maxOutputTokens) return undefined;

  const capabilityItems: CapabilityPick[] = [
    {
      label: "Tool use",
      description: "Send AgentLink function definitions",
      capability: "tools",
      picked: draft.supportsToolUse,
    },
    ...(profile === "openrouter"
      ? [
          {
            label: "Reasoning",
            description: "Expose supported reasoning efforts",
            capability: "thinking" as const,
            picked: draft.supportsThinking,
          },
        ]
      : []),
    {
      label: "Image input",
      description: "Send standard image_url inputs",
      capability: "images",
      picked: draft.supportsImages,
    },
  ];
  const capabilities = await vscode.window.showQuickPick(capabilityItems, {
    title: "Model capabilities",
    placeHolder: "Select only capabilities supported by this model/endpoint",
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!capabilities) return undefined;
  const selected = new Set(capabilities.map((item) => item.capability));

  let reasoningEfforts: CoreReasoningEffort[] | undefined;
  let defaultReasoningEffort: CoreReasoningEffort | undefined;
  if (selected.has("thinking")) {
    const effortPicks = await vscode.window.showQuickPick<ReasoningPick>(
      REASONING_EFFORTS.map((effort) => ({
        label: effort,
        effort,
        picked: draft.reasoningEfforts?.includes(effort),
      })),
      {
        title: "Supported reasoning efforts",
        placeHolder: "Select at least one supported effort",
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (!effortPicks || effortPicks.length === 0) return undefined;
    reasoningEfforts = effortPicks.map((item) => item.effort);
    const defaultPick = await vscode.window.showQuickPick<ReasoningPick>(
      reasoningEfforts.map((effort) => ({ label: effort, effort })),
      {
        title: "Default reasoning effort",
        placeHolder: "Choose the default effort",
        ignoreFocusOut: true,
      },
    );
    if (!defaultPick) return undefined;
    defaultReasoningEffort = defaultPick.effort;
  }

  return {
    ...draft,
    contextWindow,
    maxOutputTokens,
    supportsToolUse: selected.has("tools"),
    supportsThinking: selected.has("thinking"),
    supportsImages: selected.has("images"),
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(!reasoningEfforts
      ? { reasoningEfforts: undefined, defaultReasoningEffort: undefined }
      : {}),
    provenance: {
      ...draft.provenance,
      contextWindow: "default",
      maxOutputTokens: "default",
      supportsToolUse: "default",
      supportsThinking: "default",
      supportsImages: "default",
      ...(reasoningEfforts
        ? {
            reasoningEfforts: "default",
            defaultReasoningEffort: "default",
          }
        : {
            reasoningEfforts: undefined,
            defaultReasoningEffort: undefined,
          }),
    },
  };
}

async function askPositiveInteger(
  title: string,
  value: number,
  maximum = 100_000_000,
): Promise<number | undefined> {
  const input = await vscode.window.showInputBox({
    title,
    value: String(value),
    ignoreFocusOut: true,
    validateInput: (candidate) => {
      const parsed = Number(candidate);
      return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
        ? null
        : `Enter an integer from 1 through ${maximum}.`;
    },
  });
  if (!input) return undefined;
  return Number(input);
}

async function commitWizardConfiguration(args: {
  dependencies: OpenAiCompatibleModelConfigurationWizardDependencies;
  initial: unknown;
  service: ServicePick;
  baseUrl: string;
  allowInsecureHttp: boolean;
  credential: SelectedCredential;
  draft: ModelDraft;
}): Promise<void> {
  let base = args.initial as unknown[];
  let connection = buildConnection(
    args,
    base,
    args.dependencies.getReservedModelIds(),
  );
  let candidate = [...base, connection];
  let validation = args.dependencies.validateConnections(candidate);
  if (!(await showCandidateIssues(validation, args.dependencies))) return;

  const current = args.dependencies.getGlobalConnections();
  if (!sameConfiguration(current, args.initial)) {
    if (!(await requireValidExistingConfiguration(current, args.dependencies)))
      return;
    base = current as unknown[];
    connection = buildConnection(
      args,
      base,
      args.dependencies.getReservedModelIds(),
    );
    candidate = [...base, connection];
    validation = args.dependencies.validateConnections(candidate);
    if (!(await showCandidateIssues(validation, args.dependencies))) return;
    const reconfirm = await vscode.window.showWarningMessage(
      "OpenAI-compatible settings changed while this wizard was open. The model was rebased onto the latest settings.",
      { modal: true },
      "Review and Save Latest",
    );
    if (reconfirm !== "Review and Save Latest") return;
  }

  let storedCredential: StoredOpenAiCompatibleCredential | undefined;
  try {
    if (args.credential.staged) {
      const stored =
        await args.dependencies.credentials.storeStagedCredentialIfMissing(
          args.credential.staged,
        );
      if (stored.status !== "stored") {
        throw new Error(
          `API key “${args.credential.staged.apiKeyName}” was created by another operation. Rerun the wizard to use it.`,
        );
      }
      storedCredential = stored.credential;
    }

    await args.dependencies.updateGlobalConnections(candidate);
    if (
      !sameConfiguration(args.dependencies.getGlobalConnections(), candidate)
    ) {
      throw new Error(
        "OpenAI-compatible settings changed during save; success could not be verified.",
      );
    }

    const refreshed = await args.dependencies.refreshProviders();
    if (!refreshed.applied) {
      if (
        sameConfiguration(args.dependencies.getGlobalConnections(), candidate)
      ) {
        await args.dependencies.updateGlobalConnections(base);
        await args.dependencies.refreshProviders().catch(() => undefined);
      }
      throw new Error(
        refreshed.issues?.[0]?.message ??
          "The saved model could not be reconciled with the provider registry.",
      );
    }
  } catch (error) {
    let mayDeleteStoredCredential = sameConfiguration(
      args.dependencies.getGlobalConnections(),
      base,
    );
    if (
      sameConfiguration(args.dependencies.getGlobalConnections(), candidate)
    ) {
      try {
        await args.dependencies.updateGlobalConnections(base);
        await args.dependencies.refreshProviders().catch(() => undefined);
        mayDeleteStoredCredential = sameConfiguration(
          args.dependencies.getGlobalConnections(),
          base,
        );
      } catch {
        mayDeleteStoredCredential = false;
      }
    }
    if (storedCredential && mayDeleteStoredCredential) {
      await args.dependencies.credentials
        .deleteCredentialIfUnchanged(storedCredential)
        .catch(() => false);
    }
    throw error;
  }

  if (args.credential.staged?.apiKeyName) {
    await args.dependencies.credentials
      .setCredentialIndexed(args.credential.staged.apiKeyName, true)
      .catch((error) =>
        vscode.window.showWarningMessage(
          `The model was saved, but its API key name could not be added to the maintenance index: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  void vscode.window.showInformationMessage(
    `OpenAI-compatible model “${args.draft.displayName}” configured.`,
  );
}

function buildConnection(
  args: {
    service: ServicePick;
    baseUrl: string;
    allowInsecureHttp: boolean;
    credential: SelectedCredential;
    draft: ModelDraft;
  },
  existing: unknown[],
  reservedModelIds: readonly string[],
): OpenAiCompatibleConnectionDto {
  const id = generateConnectionId(
    args.service.profile,
    args.draft.model,
    existing,
    reservedModelIds,
  );
  args.draft.id = id;
  const { provenance: _provenance, ...model } = args.draft;
  return {
    id,
    displayName:
      args.service.profile === "openrouter"
        ? `OpenRouter — ${args.draft.displayName}`
        : args.draft.displayName,
    baseUrl: args.baseUrl,
    profile: args.service.profile,
    ...(args.credential.apiKeyName
      ? { authKey: args.credential.apiKeyName }
      : {}),
    ...(args.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
    models: [model],
  };
}

export function generateConnectionId(
  profile: OpenAiCompatibleProfileKind,
  wireModel: string,
  existing: unknown[],
  reservedModelIds: readonly string[] = [],
): string {
  const occupied = new Set<string>(reservedModelIds);
  for (const value of existing) {
    if (!isRecord(value)) continue;
    if (typeof value.id === "string") occupied.add(value.id);
    if (Array.isArray(value.models)) {
      for (const model of value.models) {
        if (isRecord(model) && typeof model.id === "string") {
          occupied.add(model.id);
        }
      }
    }
  }
  const prefix = profile === "openrouter" ? "openrouter" : "custom";
  const normalizedModel = wireModel
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+/g, "-")
    .replace(/[-._]+$/, "");
  const root = `${prefix}-${normalizedModel || "model"}`.slice(0, 120);
  let candidate = root;
  for (let suffix = 2; occupied.has(candidate); suffix += 1) {
    const marker = `-${suffix}`;
    candidate = `${root.slice(0, 128 - marker.length)}${marker}`;
  }
  return candidate;
}

async function showCandidateIssues(
  validation: NormalizeOpenAiCompatibleConnectionsResult,
  dependencies: OpenAiCompatibleModelConfigurationWizardDependencies,
): Promise<boolean> {
  if (validation.issues.length > 0) {
    const choice = await vscode.window.showErrorMessage(
      `The model configuration is invalid: ${validation.issues[0]!.path}: ${validation.issues[0]!.message}`,
      "Open Settings",
    );
    if (choice === "Open Settings") await dependencies.openSettings();
    return false;
  }
  return true;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "OpenAiCompatibleAbortError" || error.name === "AbortError")
  );
}

function sameConfiguration(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
