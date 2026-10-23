import { describe, expect, it, vi } from "vitest";

import { KeychainSharedCredentialStore } from "./sharedCredentialStore.js";

function fakeEntry(password: string | null) {
  return {
    getPassword: vi.fn(() => password),
    setPassword: vi.fn(),
    deletePassword: vi.fn(),
  };
}

describe("KeychainSharedCredentialStore", () => {
  it("pins Secret Service on Linux and connects only on first use", () => {
    const entry = fakeEntry(" sk-test ");
    const createEntry = vi.fn(() => entry as never);
    const store = new KeychainSharedCredentialStore("linux", createEntry);

    expect(createEntry).not.toHaveBeenCalled();
    expect(store.getOpenAiApiKey()).toBe("sk-test");
    expect(store.hasOpenAiApiKey()).toBe(true);
    expect(createEntry).toHaveBeenCalledTimes(1);
    expect(createEntry).toHaveBeenCalledWith(
      "com.agentlink.shared-credentials.v1",
      "openai-api-key:default",
      { linux: { store: "secret-service" } },
    );
  });

  it("uses the default store elsewhere", () => {
    const createEntry = vi.fn(() => fakeEntry(null) as never);
    const store = new KeychainSharedCredentialStore("darwin", createEntry);

    expect(store.getOpenAiApiKey()).toBeNull();
    expect(createEntry).toHaveBeenCalledWith(
      "com.agentlink.shared-credentials.v1",
      "openai-api-key:default",
      undefined,
    );
  });

  it("reports a missing Linux keyring from the credential call", () => {
    const store = new KeychainSharedCredentialStore("linux", () => {
      throw new Error("Platform failure: no session bus");
    });

    expect(() => store.getOpenAiApiKey()).toThrow(/no session bus/u);
  });
});
