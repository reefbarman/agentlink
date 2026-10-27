import {
  ManagedProviderInputError,
  openAiExternallyManaged,
  openManagedProviders,
  parseOpenAiKey,
} from "./managedProviders.js";
import { afterEach, describe, expect, it } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const KEY = `sk-proj-${"x".repeat(40)}`;
const OTHER_KEY = `sk-proj-${"y".repeat(40)}`;
const KNOWN = { providerId: "openai", modelId: "known" };

async function setup(
  options: { settings?: string | false; externallyManaged?: boolean } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-providers-"));
  cleanup.push(async () => {
    await fs.chmod(path.join(root, "credentials"), 0o700).catch(() => {});
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  const settingsFile = path.join(root, "settings", "model-providers.json");
  const credentialsDirectory = path.join(root, "credentials");
  if (options.settings !== false) {
    await fs.mkdir(path.dirname(settingsFile), { recursive: true });
    await fs.writeFile(
      settingsFile,
      options.settings ?? '{"schemaVersion": 1, "revision": 0}\n',
    );
  }
  const logs: string[] = [];
  const open = () =>
    openManagedProviders({
      settingsFile,
      credentialsDirectory,
      externallyManaged: options.externallyManaged ?? false,
      isKnownModel: (model) =>
        model.providerId === KNOWN.providerId &&
        model.modelId === KNOWN.modelId,
      log: (line) => logs.push(line),
    });
  return { root, settingsFile, credentialsDirectory, logs, open };
}

describe("parseOpenAiKey", () => {
  it("accepts OpenAI secret keys and nothing else, without contacting anyone", () => {
    expect(parseOpenAiKey(`  ${KEY}\n`)).toBe(KEY);
    for (const bad of [
      undefined,
      42,
      "",
      "sk-short",
      `pk-${"x".repeat(40)}`,
      `sk-${"x".repeat(30)} trailing`,
      `sk-${"x".repeat(30)}\nsecond-line`,
      "https://evil.example/key",
    ]) {
      expect(() => parseOpenAiKey(bad)).toThrow(ManagedProviderInputError);
    }
  });
});

describe("openAiExternallyManaged", () => {
  it("treats any configured OpenAI provider, or one using its ID, as externally managed", () => {
    expect(openAiExternallyManaged([{ type: "codex" }])).toBe(false);
    expect(
      openAiExternallyManaged([{ type: "openai", apiKey: { file: "/k" } }]),
    ).toBe(true);
    expect(
      openAiExternallyManaged([
        {
          type: "openai-compatible",
          id: "openai",
          baseURL: "https://example.test/v1",
          noAuth: true,
          models: [],
        },
      ]),
    ).toBe(true);
  });
});

describe("openManagedProviders", () => {
  it("offers nothing without the installer's opt-in file", async () => {
    const { open } = await setup({ settings: false });
    const providers = await open();
    expect(providers.offered).toBe(false);
    expect(providers.status().openai.state).toBe("unavailable");
    await expect(providers.saveOpenAiKey(KEY, 0, 1)).rejects.toMatchObject({
      code: "providers_unavailable",
    });
    await expect(providers.resolveOpenAiKey()).rejects.toThrow(
      /not available/u,
    );
  });

  it("never replaces or removes an OpenAI provider server.json configures", async () => {
    const { open, credentialsDirectory } = await setup({
      externallyManaged: true,
    });
    const providers = await open();
    expect(providers.offered).toBe(false);
    expect(providers.status().openai.state).toBe("externally-managed");
    await expect(providers.saveOpenAiKey(KEY, 0, 1)).rejects.toMatchObject({
      code: "provider_externally_managed",
    });
    await expect(providers.removeOpenAiKey(0, 1)).rejects.toMatchObject({
      code: "provider_externally_managed",
    });
    await expect(fs.stat(credentialsDirectory)).rejects.toThrow();
  });

  it("stores the key privately, reads it per request, and keeps it out of settings", async () => {
    const { open, settingsFile, credentialsDirectory } = await setup();
    const providers = await open();
    let changes = 0;
    providers.onChange(() => changes++);
    await expect(providers.resolveOpenAiKey()).rejects.toThrow(
      /No OpenAI API key is saved/u,
    );
    const saved = await providers.saveOpenAiKey(KEY, 0, 1_000);
    expect(saved.openai).toEqual({
      state: "saved",
      label: "sk-…xxxx",
      savedAt: 1_000,
    });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(providers.hasOpenAiKey()).toBe(true);
    expect(changes).toBe(1);
    const keyFile = path.join(credentialsDirectory, "openai-api-key");
    expect((await fs.stat(keyFile)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(credentialsDirectory)).mode & 0o777).toBe(0o700);
    expect(await fs.readFile(settingsFile, "utf8")).not.toContain("sk-");
    await expect(providers.resolveOpenAiKey()).resolves.toBe(KEY);

    // Rotation: the next request reads the new key.
    await providers.saveOpenAiKey(OTHER_KEY, saved.revision, 2_000);
    await expect(providers.resolveOpenAiKey()).resolves.toBe(OTHER_KEY);

    // Restart: the same state comes back.
    const reopened = await open();
    expect(reopened.status().openai).toMatchObject({
      state: "saved",
      label: "sk-…yyyy",
    });
    expect(reopened.status().revision).toBe(2);
  });

  it("refuses a stale tab's change and a malformed key, keeping the previous key", async () => {
    const { open } = await setup();
    const providers = await open();
    await providers.saveOpenAiKey(KEY, 0, 1);
    await expect(
      providers.saveOpenAiKey(OTHER_KEY, 0, 2),
    ).rejects.toMatchObject({ code: "providers_changed" });
    await expect(
      providers.saveOpenAiKey("not a key", 1, 2),
    ).rejects.toMatchObject({ code: "api_key_invalid" });
    await expect(providers.removeOpenAiKey(0, 2)).rejects.toMatchObject({
      code: "providers_changed",
    });
    await expect(providers.resolveOpenAiKey()).resolves.toBe(KEY);
  });

  it("keeps the earlier key when writing the new one fails", async () => {
    const { open, credentialsDirectory } = await setup();
    const providers = await open();
    const first = await providers.saveOpenAiKey(KEY, 0, 1);
    await fs.chmod(credentialsDirectory, 0o500);
    await expect(
      providers.saveOpenAiKey(OTHER_KEY, first.revision, 2),
    ).rejects.toThrow();
    await fs.chmod(credentialsDirectory, 0o700);
    expect(providers.status().openai.label).toBe("sk-…xxxx");
    await expect(providers.resolveOpenAiKey()).resolves.toBe(KEY);
  });

  it("removes the key but keeps the chosen default, so later requests fail clearly", async () => {
    const { open, credentialsDirectory } = await setup();
    const providers = await open();
    const saved = await providers.saveOpenAiKey(KEY, 0, 1);
    const chosen = await providers.setDefault(KNOWN, saved.revision);
    expect(chosen.defaultModel).toEqual(KNOWN);
    const removed = await providers.removeOpenAiKey(chosen.revision, 2);
    expect(removed.openai.state).toBe("not-set");
    expect(removed.defaultModel).toEqual(KNOWN);
    expect(providers.selectedDefault()).toEqual(KNOWN);
    expect(providers.hasOpenAiKey()).toBe(false);
    await expect(
      fs.stat(path.join(credentialsDirectory, "openai-api-key")),
    ).rejects.toThrow();
    await expect(providers.resolveOpenAiKey()).rejects.toThrow(
      /No OpenAI API key is saved/u,
    );
    // Clearing the choice goes back to server.json's default.
    const cleared = await providers.setDefault(undefined, removed.revision);
    expect(cleared.defaultModel).toBeUndefined();
    expect(providers.selectedDefault()).toBeUndefined();
  });

  it("refuses a default model this server does not offer", async () => {
    const { open } = await setup();
    const providers = await open();
    await expect(
      providers.setDefault({ providerId: "openai", modelId: "guessed" }, 0),
    ).rejects.toMatchObject({ code: "model_not_available" });
  });

  it("reports, rather than uses, a saved default the server no longer knows", async () => {
    const { open, logs } = await setup({
      settings: JSON.stringify({
        schemaVersion: 1,
        revision: 3,
        defaultModel: { providerId: "openai", modelId: "retired" },
      }),
    });
    const providers = await open();
    expect(providers.selectedDefault()).toBeUndefined();
    expect(providers.status()).toMatchObject({
      revision: 3,
      ignoredDefaultModel: { providerId: "openai", modelId: "retired" },
    });
    expect(providers.status().defaultModel).toBeUndefined();
    expect(logs.join("\n")).toContain("openai/retired");
  });

  it("starts with an unusable key file and reports it without its contents", async () => {
    const { open, credentialsDirectory, logs } = await setup();
    await fs.mkdir(credentialsDirectory, { recursive: true });
    await fs.writeFile(path.join(credentialsDirectory, "openai-api-key"), KEY, {
      mode: 0o644,
    });
    const providers = await open();
    expect(providers.status().openai).toEqual({ state: "unreadable" });
    expect(providers.hasOpenAiKey()).toBe(false);
    await expect(providers.resolveOpenAiKey()).rejects.toThrow(/chmod 600/u);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("stops on a settings file it does not recognise", async () => {
    for (const settings of [
      "not json",
      '{"schemaVersion": 2}',
      '{"schemaVersion": 1, "apiKey": "sk-inline"}',
      '{"schemaVersion": 1, "defaultModel": "openai/known"}',
    ]) {
      const { open } = await setup({ settings });
      await expect(open()).rejects.toThrow(/model provider settings file/u);
    }
  });
});
