import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  OPENAI_COMPATIBLE_KEY_INDEX_STATE,
  OpenAiCompatibleCredentialService,
  isValidOpenAiCompatibleApiKeyName,
  normalizeOpenAiCompatibleApiKeyName,
  type OpenAiCompatibleCredentialServiceDependencies,
} from "./openAiCompatibleCredentials.js";
import { OPENAI_COMPATIBLE_SECRET_PREFIX } from "./openAiCompatibleSecrets.js";

function createDependencies(options?: {
  configured?: string[];
  indexed?: unknown;
  secrets?: Record<string, string>;
}) {
  let indexed: unknown = options?.indexed ?? [];
  const secretValues = new Map(Object.entries(options?.secrets ?? {}));
  const dependencies: OpenAiCompatibleCredentialServiceDependencies = {
    secrets: {
      get: vi.fn(async (key: string) => secretValues.get(key)),
      store: vi.fn(async (key: string, value: string) => {
        secretValues.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        secretValues.delete(key);
      }),
    },
    state: {
      get<T>(_key: string, defaultValue: T): T {
        return (indexed ?? defaultValue) as T;
      },
      update: vi.fn(async (_key: string, value: unknown) => {
        indexed = value;
      }),
    },
    getConfiguredApiKeyNames: vi.fn(() => options?.configured ?? []),
  };
  return { dependencies, secretValues, getIndexed: () => indexed };
}

function secretKey(name: string): string {
  return `${OPENAI_COMPATIBLE_SECRET_PREFIX}${name}`;
}

describe("OpenAiCompatibleCredentialService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes and validates API key names", () => {
    expect(normalizeOpenAiCompatibleApiKeyName("  openrouter.main_1  ")).toBe(
      "openrouter.main_1",
    );
    expect(normalizeOpenAiCompatibleApiKeyName("UPPER")).toBeUndefined();
    expect(normalizeOpenAiCompatibleApiKeyName("-leading")).toBeUndefined();
    expect(normalizeOpenAiCompatibleApiKeyName("has spaces")).toBeUndefined();
    expect(isValidOpenAiCompatibleApiKeyName("valid-name")).toBe(true);
    expect(isValidOpenAiCompatibleApiKeyName(" valid-name ")).toBe(false);
  });

  it("returns the sorted union of normalized configured and valid indexed names", () => {
    const { dependencies } = createDependencies({
      configured: [" configured ", "shared", "INVALID"],
      indexed: ["indexed", "shared", " invalid ", 42, null],
    });
    const service = new OpenAiCompatibleCredentialService(dependencies);

    expect(service.getApiKeyNames()).toEqual([
      "configured",
      "indexed",
      "shared",
    ]);
  });

  it("ignores a malformed non-array index", () => {
    const { dependencies } = createDependencies({
      configured: ["configured"],
      indexed: { unexpected: true },
    });

    expect(
      new OpenAiCompatibleCredentialService(dependencies).getApiKeyNames(),
    ).toEqual(["configured"]);
  });

  it("reports stored and missing statuses without exposing values", async () => {
    const value = "top-secret-value";
    const { dependencies } = createDependencies({
      configured: ["missing", "stored"],
      secrets: { [secretKey("stored")]: value },
    });
    const service = new OpenAiCompatibleCredentialService(dependencies);

    await expect(service.getCredentialStatuses()).resolves.toEqual([
      { apiKeyName: "missing", status: "missing" },
      { apiKeyName: "stored", status: "stored" },
    ]);
    expect(JSON.stringify(await service.getCredentialStatuses())).not.toContain(
      value,
    );
    await expect(service.getCredentialValue("stored")).resolves.toBe(value);
    await expect(
      service.getCredentialValue("missing"),
    ).resolves.toBeUndefined();
    expect(dependencies.secrets.get).toHaveBeenCalledWith(secretKey("stored"));
  });

  it("stores and deletes using exactly the shared SecretStorage key", async () => {
    const { dependencies } = createDependencies();
    const service = new OpenAiCompatibleCredentialService(dependencies);

    await service.storeCredential("  openrouter-main  ", "  secret  ");
    await service.deleteCredential("openrouter-main");

    expect(dependencies.secrets.store).toHaveBeenCalledWith(
      secretKey("openrouter-main"),
      "secret",
    );
    expect(dependencies.secrets.delete).toHaveBeenCalledWith(
      secretKey("openrouter-main"),
    );
  });

  it("keeps staged and stored credential values out of serialization", async () => {
    const value = "never-serialize-this";
    const { dependencies } = createDependencies();
    const service = new OpenAiCompatibleCredentialService(dependencies);
    const staged = service.stageCredential("wizard-key", value);

    expect(staged).toEqual({ apiKeyName: "wizard-key" });
    expect(JSON.stringify(staged)).not.toContain(value);
    expect(service.getStagedCredentialValue(staged)).toBe(value);

    const result = await service.storeStagedCredentialIfMissing(staged);
    expect(result.status).toBe("stored");
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it("never overwrites an existing secret when storing a staged credential", async () => {
    const existing = "existing-secret";
    const { dependencies, secretValues } = createDependencies({
      secrets: { [secretKey("shared")]: existing },
    });
    const service = new OpenAiCompatibleCredentialService(dependencies);
    const staged = service.stageCredential("shared", "new-secret");

    await expect(
      service.storeStagedCredentialIfMissing(staged),
    ).resolves.toEqual({ status: "already_stored" });
    expect(dependencies.secrets.store).not.toHaveBeenCalled();
    expect(secretValues.get(secretKey("shared"))).toBe(existing);
  });

  it("serializes conditional stores so concurrent attempts cannot replace one another", async () => {
    const { dependencies, secretValues } = createDependencies();
    const firstService = new OpenAiCompatibleCredentialService(dependencies);
    const secondService = new OpenAiCompatibleCredentialService(dependencies);

    const [first, second] = await Promise.all([
      firstService.storeStagedCredentialIfMissing(
        firstService.stageCredential("shared", "first"),
      ),
      secondService.storeStagedCredentialIfMissing(
        secondService.stageCredential("shared", "second"),
      ),
    ]);

    expect([first.status, second.status]).toEqual(["stored", "already_stored"]);
    expect(secretValues.get(secretKey("shared"))).toBe("first");
  });

  it("does not block mutations for different API key names", async () => {
    const { dependencies } = createDependencies();
    let releaseFirstStore: (() => void) | undefined;
    const firstStore = new Promise<void>((resolve) => {
      releaseFirstStore = resolve;
    });
    vi.mocked(dependencies.secrets.store)
      .mockImplementationOnce(async () => {
        await firstStore;
      })
      .mockResolvedValue(undefined);
    const service = new OpenAiCompatibleCredentialService(dependencies);

    const first = service.storeCredential("first", "first-secret");
    const second = service.storeCredential("second", "second-secret");
    await expect(second).resolves.toBeUndefined();
    expect(dependencies.secrets.store).toHaveBeenCalledTimes(2);

    releaseFirstStore?.();
    await first;
  });

  it("rolls back only when the stored value still matches its receipt", async () => {
    const { dependencies, secretValues } = createDependencies();
    const service = new OpenAiCompatibleCredentialService(dependencies);
    const stored = await service.storeStagedCredentialIfMissing(
      service.stageCredential("wizard-key", "wizard-secret"),
    );
    if (stored.status !== "stored") throw new Error("Expected stored receipt");

    secretValues.set(secretKey("wizard-key"), "concurrent-replacement");

    await expect(
      service.deleteCredentialIfUnchanged(stored.credential),
    ).resolves.toBe(false);
    expect(dependencies.secrets.delete).not.toHaveBeenCalled();
    expect(secretValues.get(secretKey("wizard-key"))).toBe(
      "concurrent-replacement",
    );
  });

  it("removes the current transaction credential when it remains unchanged", async () => {
    const { dependencies, secretValues } = createDependencies();
    const service = new OpenAiCompatibleCredentialService(dependencies);
    const stored = await service.storeStagedCredentialIfMissing(
      service.stageCredential("wizard-key", "wizard-secret"),
    );
    if (stored.status !== "stored") throw new Error("Expected stored receipt");

    await expect(
      service.deleteCredentialIfUnchanged(stored.credential),
    ).resolves.toBe(true);
    expect(dependencies.secrets.delete).toHaveBeenCalledWith(
      secretKey("wizard-key"),
    );
    expect(secretValues.has(secretKey("wizard-key"))).toBe(false);

    secretValues.set(secretKey("wizard-key"), "wizard-secret");
    await expect(
      service.deleteCredentialIfUnchanged(stored.credential),
    ).rejects.toThrow("already used");
    expect(secretValues.get(secretKey("wizard-key"))).toBe("wizard-secret");
  });

  it("serializes index updates across service instances without losing names", async () => {
    let indexed: string[] = [];
    let releaseFirstUpdate: (() => void) | undefined;
    const firstUpdate = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    const state = {
      get<T>(_key: string, defaultValue: T): T {
        return (indexed.length ? [...indexed] : defaultValue) as T;
      },
      update: vi
        .fn()
        .mockImplementationOnce(async (_key: string, value: unknown) => {
          await firstUpdate;
          indexed = value as string[];
        })
        .mockImplementation(async (_key: string, value: unknown) => {
          indexed = value as string[];
        }),
    };
    const base = createDependencies().dependencies;
    const firstService = new OpenAiCompatibleCredentialService({
      ...base,
      state,
    });
    const secondService = new OpenAiCompatibleCredentialService({
      ...base,
      state,
    });

    const first = firstService.setCredentialIndexed("first", true);
    const second = secondService.setCredentialIndexed("second", true);
    await Promise.resolve();
    expect(state.update).toHaveBeenCalledTimes(1);
    releaseFirstUpdate?.();
    await Promise.all([first, second]);

    expect(indexed).toEqual(["first", "second"]);
    expect(state.update).toHaveBeenLastCalledWith(
      OPENAI_COMPATIBLE_KEY_INDEX_STATE,
      ["first", "second"],
    );
  });

  it("keeps index updates usable after a failed write", async () => {
    const { dependencies, getIndexed } = createDependencies();
    vi.mocked(dependencies.state.update)
      .mockRejectedValueOnce(new Error("state unavailable"))
      .mockImplementationOnce(async (_key: string, value: unknown) => {
        Object.defineProperty(dependencies.state, "get", {
          value: <T>(_stateKey: string, _defaultValue: T) => value as T,
        });
      });
    const service = new OpenAiCompatibleCredentialService(dependencies);

    await expect(service.setCredentialIndexed("first", true)).rejects.toThrow(
      "state unavailable",
    );
    await expect(service.setCredentialIndexed("second", true)).resolves.toBe(
      undefined,
    );
    expect(getIndexed()).toEqual([]);
    expect(dependencies.state.update).toHaveBeenLastCalledWith(
      OPENAI_COMPATIBLE_KEY_INDEX_STATE,
      ["second"],
    );
  });

  it("rejects invalid names and empty values before touching storage", async () => {
    const { dependencies } = createDependencies();
    const service = new OpenAiCompatibleCredentialService(dependencies);

    await expect(service.storeCredential("INVALID", "secret")).rejects.toThrow(
      "API key name",
    );
    expect(() => service.stageCredential("valid", "   ")).toThrow(
      "API key cannot be empty",
    );
    expect(dependencies.secrets.store).not.toHaveBeenCalled();
  });
});
