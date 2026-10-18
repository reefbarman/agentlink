import { syncDirectory, writeFileAtomic } from "./atomicFile.js";

import type { AgentModelReference } from "@agentlink/core";
import type { AssistantServerProviderConfig } from "./serverConfig.js";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Model providers the owner sets up in the browser instead of in
 * `server.json`. Only the first-class OpenAI API provider is offered, with
 * a fixed ID and the maintained model catalogue: no endpoint, path, file
 * name or command comes from the browser.
 *
 * Setup is opt-in per installation: the guided installer writes
 * `<dataRoot>/settings/model-providers.json`. Without it (an existing or
 * hand-made installation) nothing here is offered and `server.json` stays
 * the only provider configuration. A provider `server.json` already
 * declares as OpenAI is "externally managed": the browser can neither
 * replace nor remove it.
 *
 * The key lives alone in `<dataRoot>/credentials/openai-api-key` (0600) and
 * is reread on every model request, so a saved, replaced or removed key
 * applies to the next request without a restart. The settings file holds
 * no key, only the owner's default model choice and a revision.
 *
 * Saving a key never sends a request: the first chat (or an explicitly
 * labelled connection test) is the first billable call.
 */

export const MANAGED_OPENAI_PROVIDER_ID = "openai";
export const MANAGED_OPENAI_DISPLAY_NAME = "OpenAI API";
const KEY_FILE = "openai-api-key";
const MAX_SETTINGS_BYTES = 16 * 1024;
const MAX_KEY_BYTES = 16 * 1024;
/** OpenAI secret keys: `sk-` then letters, digits, `-` and `_`. */
const OPENAI_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{20,500}$/u;

export class ManagedProviderInputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** What the browser may know about the managed OpenAI key. Never the key. */
export type ManagedOpenAiState =
  /** No managed setup on this installation. */
  | "unavailable"
  /** `server.json` declares an OpenAI provider; change it there. */
  | "externally-managed"
  | "not-set"
  | "saved"
  /** The file is there but unusable (permissions, size, contents). */
  | "unreadable";

export interface ManagedProviderStatus {
  readonly revision: number;
  readonly openai: {
    readonly state: ManagedOpenAiState;
    /** `sk-…abcd`: enough to tell two keys apart, never enough to use one. */
    readonly label?: string;
    readonly savedAt?: number;
  };
  /** The owner's explicit choice for new chats; absent: `server.json`'s. */
  readonly defaultModel?: AgentModelReference;
  /** A stored choice this server no longer knows (shown, not used). */
  readonly ignoredDefaultModel?: AgentModelReference;
}

export interface ManagedProviders {
  /** Whether the browser may set up the managed OpenAI provider. */
  readonly offered: boolean;
  status(): ManagedProviderStatus;
  /** Whether a usable key was found at the last open, save or removal. */
  hasOpenAiKey(): boolean;
  /** Reads the key for one model request; throws when there is none. */
  resolveOpenAiKey(): Promise<string>;
  /** Checks the key's shape (never contacts OpenAI) and stores it. */
  saveOpenAiKey(
    key: unknown,
    expectedRevision: number,
    now: number,
  ): Promise<ManagedProviderStatus>;
  removeOpenAiKey(
    expectedRevision: number,
    now: number,
  ): Promise<ManagedProviderStatus>;
  /** The owner's default for new chats, if one is set and still known. */
  selectedDefault(): AgentModelReference | undefined;
  /** Undefined clears the choice (back to `server.json`'s default). */
  setDefault(
    model: AgentModelReference | undefined,
    expectedRevision: number,
  ): Promise<ManagedProviderStatus>;
  /** Called after every successful change. */
  onChange(listener: () => void): () => void;
}

interface SettingsRecord {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly defaultModel?: AgentModelReference;
}

/** The fixed managed OpenAI provider, as server configuration. */
export function managedOpenAiProviderConfig(
  credentialsDirectory: string,
): Extract<AssistantServerProviderConfig, { type: "openai" }> {
  return {
    type: "openai",
    id: MANAGED_OPENAI_PROVIDER_ID,
    displayName: MANAGED_OPENAI_DISPLAY_NAME,
    // Where the key lives; read through `resolveOpenAiKey`, never inlined.
    apiKey: { file: path.join(credentialsDirectory, KEY_FILE) },
  };
}

/**
 * True when `server.json` already has an OpenAI provider, or another
 * provider uses the managed provider's ID: the browser must not add a
 * second one or shadow it.
 */
export function openAiExternallyManaged(
  providers: readonly AssistantServerProviderConfig[],
): boolean {
  return providers.some(
    (provider) =>
      provider.type === "openai" ||
      (provider.id ?? provider.type) === MANAGED_OPENAI_PROVIDER_ID,
  );
}

/** Check a pasted key's shape. Never contacts OpenAI. */
export function parseOpenAiKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new ManagedProviderInputError("api_key_invalid");
  }
  const key = value.trim();
  if (!OPENAI_KEY_PATTERN.test(key)) {
    throw new ManagedProviderInputError("api_key_invalid");
  }
  return key;
}

export function redactOpenAiKey(key: string): string {
  return `sk-…${key.slice(-4)}`;
}

function parseSettings(raw: string, file: string): SettingsRecord {
  const invalid = () =>
    new Error(
      `${file} is not a model provider settings file this server reads`,
    );
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw invalid();
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    Object.keys(value).some(
      (key) => !["schemaVersion", "revision", "defaultModel"].includes(key),
    )
  ) {
    throw invalid();
  }
  const revision = value.revision ?? 0;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw invalid();
  }
  let defaultModel: AgentModelReference | undefined;
  if (value.defaultModel !== undefined && value.defaultModel !== null) {
    const model = value.defaultModel as Record<string, unknown>;
    if (
      !model ||
      typeof model !== "object" ||
      typeof model.providerId !== "string" ||
      typeof model.modelId !== "string" ||
      Object.keys(model).length !== 2
    ) {
      throw invalid();
    }
    defaultModel = { providerId: model.providerId, modelId: model.modelId };
  }
  return {
    schemaVersion: 1,
    revision,
    ...(defaultModel ? { defaultModel } : {}),
  };
}

type KeyRead =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly reason: string }
  | { readonly kind: "ok"; readonly key: string; readonly savedAt: number };

async function readKeyFile(file: string): Promise<KeyRead> {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "unreadable", reason: "cannot be read" };
  }
  if (!stat.isFile()) return { kind: "unreadable", reason: "is not a file" };
  if ((stat.mode & 0o077) !== 0) {
    return {
      kind: "unreadable",
      reason: "is readable by group or others (chmod 600)",
    };
  }
  if (stat.size > MAX_KEY_BYTES) {
    return { kind: "unreadable", reason: "is too large" };
  }
  const key = (await fs.readFile(file, "utf8")).trim();
  if (!OPENAI_KEY_PATTERN.test(key)) {
    return { kind: "unreadable", reason: "does not hold an OpenAI key" };
  }
  return { kind: "ok", key, savedAt: Math.floor(stat.mtimeMs) };
}

/**
 * Open managed provider setup. A missing settings file means "not opted
 * in". An unrecognised settings file stops the server rather than
 * silently dropping the owner's choice. A missing or unusable key never
 * stops it: the server starts, reports it, and the owner can fix it.
 */
export async function openManagedProviders(options: {
  readonly settingsFile: string;
  readonly credentialsDirectory: string;
  /** From `openAiExternallyManaged(config.providers)`. */
  readonly externallyManaged: boolean;
  /** Whether a stored default is a model this server can serve. */
  readonly isKnownModel: (model: AgentModelReference) => boolean;
  readonly log?: (message: string) => void;
}): Promise<ManagedProviders> {
  const keyFile = path.join(options.credentialsDirectory, KEY_FILE);
  let settings: SettingsRecord | undefined;
  try {
    const stat = await fs.lstat(options.settingsFile);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) {
      throw new Error(
        `${options.settingsFile} is not a model provider settings file this server reads`,
      );
    }
    settings = parseSettings(
      await fs.readFile(options.settingsFile, "utf8"),
      options.settingsFile,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const optedIn = settings !== undefined;
  const offered = optedIn && !options.externallyManaged;

  let ignoredDefault: AgentModelReference | undefined;
  if (settings?.defaultModel && !options.isKnownModel(settings.defaultModel)) {
    ignoredDefault = settings.defaultModel;
    options.log?.(
      `Ignoring the saved default model ${settings.defaultModel.providerId}/${settings.defaultModel.modelId}: this server does not offer it. Choose another in Setup.`,
    );
  }

  let key: KeyRead = offered
    ? await readKeyFile(keyFile).catch((): KeyRead => ({
        kind: "unreadable",
        reason: "cannot be read",
      }))
    : { kind: "missing" };
  if (key.kind === "unreadable") {
    options.log?.(
      `The saved OpenAI API key ${key.reason}; add it again in Setup.`,
    );
  }

  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A listener's failure must not undo a saved change.
      }
    }
  };

  const status = (): ManagedProviderStatus => {
    const state: ManagedOpenAiState = !optedIn
      ? "unavailable"
      : options.externallyManaged
        ? "externally-managed"
        : key.kind === "ok"
          ? "saved"
          : key.kind === "unreadable"
            ? "unreadable"
            : "not-set";
    return {
      revision: settings?.revision ?? 0,
      openai: {
        state,
        ...(key.kind === "ok"
          ? { label: redactOpenAiKey(key.key), savedAt: key.savedAt }
          : {}),
      },
      ...(settings?.defaultModel && !ignoredDefault
        ? { defaultModel: { ...settings.defaultModel } }
        : {}),
      ...(ignoredDefault ? { ignoredDefaultModel: { ...ignoredDefault } } : {}),
    };
  };

  const writeSettings = async (next: SettingsRecord) => {
    await fs.mkdir(path.dirname(options.settingsFile), {
      recursive: true,
      mode: 0o700,
    });
    await writeFileAtomic(
      options.settingsFile,
      `${JSON.stringify(next, null, 2)}\n`,
    );
    settings = next;
  };

  /** After a failed write: reread what is on disk, so status matches use. */
  const resync = async () => {
    const before = key.kind === "ok" ? key.key : undefined;
    key = await readKeyFile(keyFile).catch((): KeyRead => ({
      kind: "unreadable",
      reason: "cannot be read",
    }));
    if ((key.kind === "ok" ? key.key : undefined) !== before) changed();
  };

  let writes: Promise<unknown> = Promise.resolve();
  const serialise = <T>(work: () => Promise<T>): Promise<T> => {
    const run = writes.then(work);
    writes = run.catch(() => undefined);
    return run;
  };
  const checkRevision = (expected: number) => {
    if (!settings) throw new ManagedProviderInputError("providers_unavailable");
    if (settings.revision !== expected) {
      throw new ManagedProviderInputError("providers_changed");
    }
    return settings;
  };
  const requireOffered = () => {
    if (!optedIn) throw new ManagedProviderInputError("providers_unavailable");
    if (options.externallyManaged) {
      throw new ManagedProviderInputError("provider_externally_managed");
    }
  };

  return {
    offered,
    status,
    hasOpenAiKey: () => offered && key.kind === "ok",
    async resolveOpenAiKey() {
      if (!offered) throw new Error("Managed OpenAI setup is not available");
      const current = await readKeyFile(keyFile).catch((): KeyRead => ({
        kind: "unreadable",
        reason: "cannot be read",
      }));
      if (current.kind === "ok") return current.key;
      if (current.kind === "missing") {
        throw new Error(
          "No OpenAI API key is saved for this Assistant. Add one in Setup.",
        );
      }
      throw new Error(
        `The saved OpenAI API key ${current.reason}. Add it again in Setup.`,
      );
    },
    saveOpenAiKey(value, expectedRevision, now) {
      return serialise(async () => {
        requireOffered();
        const parsed = parseOpenAiKey(value);
        const base = checkRevision(expectedRevision);
        // The revision first: a stale tab is refused even if the key write
        // then fails, and that failure leaves the earlier key in place.
        await writeSettings({ ...base, revision: base.revision + 1 });
        try {
          await fs.mkdir(options.credentialsDirectory, {
            recursive: true,
            mode: 0o700,
          });
          await writeFileAtomic(keyFile, `${parsed}\n`, 0o600);
        } catch (error) {
          // A failure before the rename keeps the earlier key; one after it
          // (syncing the directory) already put the new key in place. Show
          // whichever key requests will now use.
          await resync();
          throw error;
        }
        key = { kind: "ok", key: parsed, savedAt: now };
        changed();
        return status();
      });
    },
    removeOpenAiKey(expectedRevision) {
      return serialise(async () => {
        requireOffered();
        const base = checkRevision(expectedRevision);
        await writeSettings({ ...base, revision: base.revision + 1 });
        try {
          await fs.unlink(keyFile);
          await syncDirectory(options.credentialsDirectory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            await resync();
            throw error;
          }
        }
        // The default stays as chosen: new chats on it fail clearly until
        // a key is added or another default is chosen.
        key = { kind: "missing" };
        changed();
        return status();
      });
    },
    selectedDefault: () =>
      settings?.defaultModel && !ignoredDefault
        ? { ...settings.defaultModel }
        : undefined,
    setDefault(model, expectedRevision) {
      return serialise(async () => {
        if (!optedIn) {
          throw new ManagedProviderInputError("providers_unavailable");
        }
        const base = checkRevision(expectedRevision);
        if (model && !options.isKnownModel(model)) {
          throw new ManagedProviderInputError("model_not_available");
        }
        const { defaultModel: _previous, ...rest } = base;
        await writeSettings({
          ...rest,
          revision: base.revision + 1,
          ...(model
            ? {
                defaultModel: {
                  providerId: model.providerId,
                  modelId: model.modelId,
                },
              }
            : {}),
        });
        ignoredDefault = undefined;
        changed();
        return status();
      });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
