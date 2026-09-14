import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { describe, expect, it, vi } from "vitest";

import { BrowserGatewayAskAgentPreferencesStore } from "./browserGatewayAskAgentPreferences.js";

async function makePreferencesPath(): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-ask-agent-preferences-"),
  );
  return path.join(dir, "preferences.json");
}

describe("BrowserGatewayAskAgentPreferencesStore", () => {
  it("persists and sanitizes Ask Agent model preferences", async () => {
    const filePath = await makePreferencesPath();
    const store = new BrowserGatewayAskAgentPreferencesStore({ filePath });

    expect(await store.read()).toEqual({});
    await store.update({
      model: " claude-sonnet-4-5 ",
      modelOwnerId: " vscode-owner-1 ",
      reasoningEffort: "high",
      webPolicy: {
        settings: {
          searchBackend: "native",
          fetchBackend: "native",
          nativeSearchMode: "cached",
          allowedDomains: [],
          blockedDomains: [],
          maxSearchUsesPerTurn: 5,
          maxFetchUsesPerTurn: 3,
          maxFetchContentTokens: 25_000,
          maxReplayBytesPerTurn: 5_242_880,
        },
        sourceInstanceId: "window-1",
        sourceRevision: "revision-1",
        updatedAt: 123,
      },
    });

    const reloaded = new BrowserGatewayAskAgentPreferencesStore({ filePath });
    expect(await reloaded.read()).toEqual({
      model: "claude-sonnet-4-5",
      modelOwnerId: "vscode-owner-1",
      reasoningEffort: "high",
      webPolicy: {
        settings: expect.objectContaining({
          searchBackend: "native",
          fetchBackend: "native",
        }),
        sourceInstanceId: "window-1",
        sourceRevision: "revision-1",
        updatedAt: 123,
      },
    });

    await fs.writeFile(
      filePath,
      JSON.stringify({
        model: " ",
        modelOwnerId: " ",
        reasoningEffort: "invalid",
      }),
      "utf-8",
    );
    expect(await reloaded.read()).toEqual({
      model: "claude-sonnet-4-5",
      modelOwnerId: undefined,
      reasoningEffort: "high",
      webPolicy: undefined,
    });

    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  });

  it("clears a stale owner when a shared ask model replaces the legacy model", async () => {
    const filePath = await makePreferencesPath();
    await fs.writeFile(
      filePath,
      JSON.stringify({ model: "legacy-model", modelOwnerId: "legacy-owner" }),
      "utf-8",
    );
    const sessionPreferencesStore = {
      read: vi.fn(async () => ({
        modeModels: { ask: "shared-model" },
        modeReasoningEfforts: {},
        modelCondenseThresholds: {},
      })),
      importLegacyIfAbsent: vi.fn(),
      update: vi.fn(),
    };
    const store = new BrowserGatewayAskAgentPreferencesStore({
      filePath,
      sessionPreferencesStore: sessionPreferencesStore as never,
    });

    await expect(store.read()).resolves.toMatchObject({
      model: "shared-model",
      modelOwnerId: undefined,
    });
    expect(sessionPreferencesStore.importLegacyIfAbsent).not.toHaveBeenCalled();
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  });

  it("falls back to legacy preferences when the shared file is unreadable", async () => {
    const filePath = await makePreferencesPath();
    await fs.writeFile(
      filePath,
      JSON.stringify({ model: "legacy-model", reasoningEffort: "low" }),
      "utf-8",
    );
    const log = vi.fn();
    const store = new BrowserGatewayAskAgentPreferencesStore({
      filePath,
      log,
      sessionPreferencesStore: {
        read: vi.fn(async () => {
          throw new Error("newer schema");
        }),
      } as never,
    });

    await expect(store.read()).resolves.toMatchObject({
      model: "legacy-model",
      reasoningEffort: "low",
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Shared session preferences unavailable"),
    );
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  });

  it("does not rewrite shared preferences for a web-policy-only update", async () => {
    const filePath = await makePreferencesPath();
    const update = vi.fn();
    const store = new BrowserGatewayAskAgentPreferencesStore({
      filePath,
      sessionPreferencesStore: { update } as never,
    });

    await store.update({
      webPolicy: {
        settings: {
          searchBackend: "disabled",
          fetchBackend: "disabled",
          nativeSearchMode: "cached",
          allowedDomains: [],
          blockedDomains: [],
          maxSearchUsesPerTurn: 5,
          maxFetchUsesPerTurn: 3,
          maxFetchContentTokens: 25_000,
          maxReplayBytesPerTurn: 5_242_880,
        },
        updatedAt: 123,
      },
    });

    expect(update).not.toHaveBeenCalled();
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  });

  it("serializes concurrent read-modify-write updates", async () => {
    const filePath = await makePreferencesPath();
    const store = new BrowserGatewayAskAgentPreferencesStore({ filePath });

    await Promise.all([
      store.update({ model: "gpt-5.3-codex" }),
      store.update({ reasoningEffort: "high" }),
    ]);

    await expect(store.read()).resolves.toEqual({
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });
  });
});
