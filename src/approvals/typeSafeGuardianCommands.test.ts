import {
  registerTypeSafeGuardianCommands,
  type TypeSafeGuardianCommandDependencies,
} from "./typeSafeGuardianCommands.js";
import { TYPESAFE_GUARDIAN_API_KEY_SECRET } from "./typeSafeGuardianShadow.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { commandHandlers, showInputBox, showInformationMessage } = vi.hoisted(
  () => ({
    commandHandlers: new Map<string, (...args: unknown[]) => unknown>(),
    showInputBox: vi.fn(),
    showInformationMessage: vi.fn(),
  }),
);

vi.mock("vscode", () => ({
  commands: {
    registerCommand: vi.fn(
      (name: string, handler: (...args: unknown[]) => unknown) => {
        commandHandlers.set(name, handler);
        return { dispose: vi.fn() };
      },
    ),
  },
  window: { showInputBox, showInformationMessage },
}));

function createDependencies(): TypeSafeGuardianCommandDependencies {
  return {
    secrets: {
      store: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
  };
}

async function invoke(name: string): Promise<void> {
  await commandHandlers.get(name)?.();
}

describe("registerTypeSafeGuardianCommands", () => {
  beforeEach(() => {
    commandHandlers.clear();
    vi.clearAllMocks();
  });

  it("registers set and clear commands", () => {
    registerTypeSafeGuardianCommands(createDependencies());
    expect([...commandHandlers.keys()]).toEqual([
      "agentlink.setTypeSafeGuardianApiKey",
      "agentlink.clearTypeSafeGuardianApiKey",
    ]);
  });

  it("stores the trimmed API key only in SecretStorage", async () => {
    const dependencies = createDependencies();
    registerTypeSafeGuardianCommands(dependencies);
    showInputBox.mockResolvedValue("  typesafe-secret  ");

    await invoke("agentlink.setTypeSafeGuardianApiKey");

    expect(showInputBox).toHaveBeenCalledWith(
      expect.objectContaining({ password: true }),
    );
    expect(dependencies.secrets.store).toHaveBeenCalledWith(
      TYPESAFE_GUARDIAN_API_KEY_SECRET,
      "typesafe-secret",
    );
  });

  it("clears the TypeSafe credential", async () => {
    const dependencies = createDependencies();
    registerTypeSafeGuardianCommands(dependencies);

    await invoke("agentlink.clearTypeSafeGuardianApiKey");

    expect(dependencies.secrets.delete).toHaveBeenCalledWith(
      TYPESAFE_GUARDIAN_API_KEY_SECRET,
    );
  });
});
