import {
  OPENAI_COMPATIBLE_KEY_INDEX_STATE,
  OPENAI_COMPATIBLE_SECRET_PREFIX,
  registerOpenAiCompatibleAuthCommands,
} from "./openAiCompatibleAuthCommands.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { commandHandlers, showQuickPick, showInputBox, showInformationMessage } =
  vi.hoisted(() => ({
    commandHandlers: new Map<string, (...args: unknown[]) => unknown>(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showInformationMessage: vi.fn(),
  }));

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn(
      (name: string, handler: (...args: unknown[]) => unknown) => {
        commandHandlers.set(name, handler);
        return { dispose: vi.fn() };
      },
    ),
  },
  window: { showQuickPick, showInputBox, showInformationMessage },
}));

function createDependencies(
  index: string[] = [],
  configuredAuthKeys: string[] = ["openrouter-main", "shared"],
) {
  const stateValue = [...index];
  const dependencies = {
    secrets: {
      get: vi.fn(async () => undefined),
      store: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
    state: {
      get<T>(_key: string, defaultValue: T): T {
        return (stateValue.length ? [...stateValue] : defaultValue) as T;
      },
      update: vi.fn(async (_key: string, value: unknown) => {
        stateValue.splice(0, stateValue.length, ...((value as string[]) ?? []));
      }),
    },
    getConfiguredAuthKeys: vi.fn(() => configuredAuthKeys),
    onCredentialChanged: vi.fn(async () => {}),
  };
  return dependencies;
}

async function invoke(name: string, ...args: unknown[]): Promise<void> {
  await commandHandlers.get(name)?.(...args);
}

describe("registerOpenAiCompatibleAuthCommands", () => {
  beforeEach(() => {
    commandHandlers.clear();
    vi.clearAllMocks();
  });

  it("registers set and clear commands", () => {
    registerOpenAiCompatibleAuthCommands(createDependencies());
    expect([...commandHandlers.keys()]).toEqual([
      "agentlink.setOpenAiCompatibleApiKey",
      "agentlink.clearOpenAiCompatibleApiKey",
    ]);
  });

  it("stores a preferred named key securely and indexes only its name", async () => {
    const dependencies = createDependencies();
    registerOpenAiCompatibleAuthCommands(dependencies);
    showInputBox.mockResolvedValue("  secret-value  ");

    await invoke("agentlink.setOpenAiCompatibleApiKey", "openrouter-main");

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(dependencies.secrets.store).toHaveBeenCalledWith(
      `${OPENAI_COMPATIBLE_SECRET_PREFIX}openrouter-main`,
      "secret-value",
    );
    expect(dependencies.state.update).toHaveBeenCalledWith(
      OPENAI_COMPATIBLE_KEY_INDEX_STATE,
      ["openrouter-main"],
    );
    expect(JSON.stringify(dependencies.state.update.mock.calls)).not.toContain(
      "secret-value",
    );
    expect(JSON.stringify(dependencies.state.update.mock.calls)).not.toContain(
      "openaiCompatibleApiKey:",
    );
    expect(dependencies.onCredentialChanged).toHaveBeenCalledWith(
      "openrouter-main",
    );
  });

  it("asks for one key name directly on first use", async () => {
    const dependencies = createDependencies([], []);
    registerOpenAiCompatibleAuthCommands(dependencies);
    showInputBox
      .mockResolvedValueOnce("openrouter-main")
      .mockResolvedValueOnce("secret-value");

    await invoke("agentlink.setOpenAiCompatibleApiKey");

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(showInputBox).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: "OpenAI-compatible API key name",
        placeHolder: "For example: openrouter-main",
      }),
    );
    expect(showInputBox).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        title: "API key: openrouter-main",
        password: true,
      }),
    );
    expect(dependencies.secrets.store).toHaveBeenCalledWith(
      `${OPENAI_COMPATIBLE_SECRET_PREFIX}openrouter-main`,
      "secret-value",
    );
  });

  it("offers the union of configured and indexed names", async () => {
    const dependencies = createDependencies(["indexed-only", "shared"]);
    registerOpenAiCompatibleAuthCommands(dependencies);
    showQuickPick.mockResolvedValue(undefined);

    await invoke("agentlink.clearOpenAiCompatibleApiKey");

    expect(showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ authKey: "indexed-only" }),
        expect.objectContaining({ authKey: "openrouter-main" }),
        expect.objectContaining({ authKey: "shared" }),
        expect.objectContaining({ manual: true, alwaysShow: true }),
      ]),
      expect.any(Object),
    );
  });

  it("deletes a secret before removing its indexed name", async () => {
    const dependencies = createDependencies(["openrouter-main", "other"]);
    registerOpenAiCompatibleAuthCommands(dependencies);

    await invoke("agentlink.clearOpenAiCompatibleApiKey", "openrouter-main");

    expect(dependencies.secrets.delete).toHaveBeenCalledWith(
      `${OPENAI_COMPATIBLE_SECRET_PREFIX}openrouter-main`,
    );
    expect(dependencies.state.update).toHaveBeenCalledWith(
      OPENAI_COMPATIBLE_KEY_INDEX_STATE,
      ["other"],
    );
    expect(dependencies.onCredentialChanged).toHaveBeenCalledWith(
      "openrouter-main",
    );
  });

  it("rejects invalid manual key names", async () => {
    const dependencies = createDependencies();
    registerOpenAiCompatibleAuthCommands(dependencies);
    showQuickPick.mockResolvedValue({ manual: true });
    showInputBox.mockResolvedValue("UPPER CASE");

    await invoke("agentlink.setOpenAiCompatibleApiKey");

    expect(dependencies.secrets.store).not.toHaveBeenCalled();
  });
});
