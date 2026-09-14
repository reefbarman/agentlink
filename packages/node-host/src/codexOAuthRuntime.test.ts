import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENTLINK_SHARED_KEYCHAIN_SERVICE,
  CODEX_OAUTH_CREDENTIALS_STORAGE_KEY,
  createCodexOAuthRuntime,
  type CodexCredentials,
} from "./index.js";

const values = new Map<string, string>();

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    constructor(
      private readonly service: string,
      private readonly account: string,
    ) {}

    async getPassword(): Promise<string | undefined> {
      return values.get(`${this.service}:${this.account}`);
    }

    async setPassword(value: string): Promise<void> {
      values.set(`${this.service}:${this.account}`, value);
    }

    async deletePassword(): Promise<boolean> {
      return values.delete(`${this.service}:${this.account}`);
    }
  },
}));

const temporaryRoots: string[] = [];

function credentials(accountId: string, token: string): CodexCredentials {
  return {
    accessToken: token,
    refreshToken: `refresh-${accountId}`,
    expiresAt: Date.now() + 60 * 60 * 1000,
    email: `${accountId}@example.com`,
    accountId: `chatgpt-${accountId}`,
  };
}

async function createRuntime() {
  const lockRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-codex-runtime-"),
  );
  temporaryRoots.push(lockRoot);
  const runtime = createCodexOAuthRuntime<{ sessionId: string }>({
    keychain: { lockRoot },
    log: () => undefined,
  });
  await runtime.ready();
  return runtime;
}

const request = {
  context: { sessionId: "session-1" },
  modelId: "gpt-5.5",
  purpose: "complete" as const,
};

afterEach(async () => {
  values.clear();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("createCodexOAuthRuntime", () => {
  it("uses the established shared Keychain service and account", async () => {
    const runtime = await createRuntime();
    await runtime.manager.saveOAuthAccount(credentials("one", "token-one"));

    expect(
      values.has(
        `${AGENTLINK_SHARED_KEYCHAIN_SERVICE}:${CODEX_OAUTH_CREDENTIALS_STORAGE_KEY}`,
      ),
    ).toBe(true);
  });

  it("shares the account pool across runtimes and resolves active credentials", async () => {
    const first = await createRuntime();
    const accountOne = await first.manager.saveOAuthAccount(
      credentials("one", "token-one"),
      { makeActive: true },
    );
    const accountTwo = await first.manager.saveOAuthAccount(
      credentials("two", "token-two"),
      { makeActive: false },
    );

    const second = await createRuntime();
    await expect(second.provider.resolveAuth(request)).resolves.toMatchObject({
      bearerToken: "token-one",
      accountId: "chatgpt-one",
      oauthAccountPoolId: accountOne.account.id,
      canRefresh: true,
    });
    await expect(
      second.provider.oauthAccounts?.listFallbackAccountIds({
        ...request,
        accountId: accountOne.account.id,
      }),
    ).resolves.toEqual([accountTwo.account.id, accountOne.account.id]);

    await second.provider.oauthAccounts?.markUsageLimit({
      ...request,
      accountId: accountOne.account.id,
    });
    await second.provider.oauthAccounts?.activateAccount({
      ...request,
      accountId: accountTwo.account.id,
    });

    expect(
      (await second.manager.getAccountById(accountOne.account.id))
        ?.lastUsageLimitAt,
    ).toEqual(expect.any(Number));
    await expect(second.provider.resolveAuth(request)).resolves.toMatchObject({
      bearerToken: "token-two",
      oauthAccountPoolId: accountTwo.account.id,
    });
  });
});
