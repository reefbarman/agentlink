import { afterEach, describe, expect, it } from "vitest";
import {
  configuredModels,
  loadAssistantServerConfig,
  parseAssistantServerConfig,
  prepareSecret,
  resolveWorkspaceProviders,
} from "./serverConfig.js";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "server-config-"));
  cleanup.push(dir);
  return dir;
}

function validConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    dataRoot: "data",
    listen: { host: "127.0.0.1", port: 8443 },
    publicOrigins: ["https://assistant.home.arpa:8443"],
    tls: { certFile: "tls/server.crt", keyFile: "tls/server.key" },
    defaultModel: { providerId: "local", modelId: "fixture" },
    providers: [
      {
        type: "openai-compatible",
        id: "local",
        baseURL: "http://127.0.0.1:11434/v1",
        noAuth: true,
        models: [
          {
            id: "fixture",
            contextWindow: 32_768,
            maxOutputTokens: 4_096,
            supportsToolUse: true,
          },
        ],
      },
    ],
    projects: [{ id: "home", label: "Home", root: "projects/home" }],
  };
}

const withChange = (change: (config: Record<string, unknown>) => void) => {
  const config = validConfig();
  change(config);
  return config;
};

describe("parseAssistantServerConfig", () => {
  it("parses a review model role and lists configured models", () => {
    const config = parseAssistantServerConfig(
      withChange((value) => {
        (value.providers as unknown[]).push({
          type: "codex",
          displayName: "ChatGPT",
          modelIds: ["gpt-6.1-sol"],
        });
        value.modelRoles = {
          review: { providerId: "local", modelId: "fixture" },
        };
      }),
      "/etc/agentlink",
    );
    expect(config.modelRoles).toEqual({
      review: { providerId: "local", modelId: "fixture" },
    });
    expect(configuredModels(config)).toEqual([
      { providerId: "local", modelId: "fixture" },
      {
        providerId: "codex",
        modelId: "gpt-6.1-sol",
        providerDisplayName: "ChatGPT",
      },
    ]);
  });

  it("resolves relative paths against the configuration directory", () => {
    const config = parseAssistantServerConfig(validConfig(), "/etc/agentlink");
    expect(config).toMatchObject({
      dataRoot: "/etc/agentlink/data",
      tls: {
        certFile: "/etc/agentlink/tls/server.crt",
        keyFile: "/etc/agentlink/tls/server.key",
      },
      projects: [
        { id: "home", label: "Home", root: "/etc/agentlink/projects/home" },
      ],
      listen: { host: "127.0.0.1", port: 8443 },
    });
  });

  it.each([
    [
      "unknown keys",
      withChange((config) => {
        config.listne = {};
      }),
      'unknown key "listne"',
    ],
    [
      "a plain-HTTP remote provider",
      withChange((config) => {
        (config.providers as Array<Record<string, unknown>>)[0]!.baseURL =
          "http://models.example.com/v1";
      }),
      "must use HTTPS, loopback HTTP",
    ],
    [
      "plain HTTP to a LAN address even with allowInsecureHttp",
      withChange((config) => {
        const provider = (
          config.providers as Array<Record<string, unknown>>
        )[0]!;
        provider.baseURL = "http://192.168.1.20:3456/v1";
        provider.allowInsecureHttp = true;
      }),
      "must use HTTPS, loopback HTTP",
    ],
    [
      "plain HTTP to a container name without allowInsecureHttp",
      withChange((config) => {
        (config.providers as Array<Record<string, unknown>>)[0]!.baseURL =
          "http://meridian:3456/v1";
      }),
      "set allowInsecureHttp: true",
    ],
    [
      "both apiKey and noAuth",
      withChange((config) => {
        (config.providers as Array<Record<string, unknown>>)[0]!.apiKey = {
          file: "/etc/agentlink/key",
        };
      }),
      "exactly one of apiKey or noAuth",
    ],
    [
      "an inline API key",
      withChange((config) => {
        const provider = (
          config.providers as Array<Record<string, unknown>>
        )[0]!;
        delete provider.noAuth;
        provider.apiKey = "sk-inline";
      }),
      "apiKey must be an object",
    ],
    [
      "duplicate project roots",
      withChange((config) => {
        config.projects = [
          { id: "one", root: "projects/home" },
          { id: "two", root: "projects/home" },
        ];
      }),
      "Duplicate project root",
    ],
    [
      "an invalid project id",
      withChange((config) => {
        config.projects = [{ id: "Home", root: "projects/home" }];
      }),
      "lowercase letters",
    ],
    [
      "an unknown default provider",
      withChange((config) => {
        config.defaultModel = { providerId: "missing", modelId: "fixture" };
      }),
      "does not match a provider",
    ],
    [
      "a default model the provider does not declare",
      withChange((config) => {
        config.defaultModel = { providerId: "local", modelId: "missing" };
      }),
      'defaultModel.modelId is not a model of provider "local"',
    ],
    [
      "an unknown model role",
      withChange((config) => {
        config.modelRoles = {
          planner: { providerId: "local", modelId: "fixture" },
        };
      }),
      'unknown key "planner"',
    ],
    [
      "a review role on an undeclared model",
      withChange((config) => {
        config.modelRoles = {
          review: { providerId: "local", modelId: "missing" },
        };
      }),
      "modelRoles.review.modelId is not a model",
    ],
    [
      "a plain-HTTP public origin",
      withChange((config) => {
        config.publicOrigins = ["http://assistant.home.arpa:8443"];
      }),
      "bare https:// origins",
    ],
    [
      "a local CA mixed with certificate files",
      withChange((config) => {
        config.tls = { localCa: true, certFile: "tls/server.crt" };
      }),
      'unknown key "certFile"',
    ],
    [
      "a disabled local CA flag",
      withChange((config) => {
        config.tls = { localCa: false };
      }),
      "tls.localCa must be true",
    ],
    [
      "an API key on a codex (sign-in) provider",
      withChange((config) => {
        config.providers = [
          ...(config.providers as unknown[]),
          {
            type: "codex",
            modelIds: ["gpt-6.1-sol"],
            apiKey: { file: "/etc/agentlink/key" },
          },
        ];
      }),
      'unknown key "apiKey"',
    ],
    [
      "an out-of-range port",
      withChange((config) => {
        config.listen = { host: "127.0.0.1", port: 70_000 };
      }),
      "listen.port",
    ],
    [
      "a command worker on a LAN address",
      withChange((config) => {
        config.commandWorker = {
          host: "192.168.1.20",
          port: 7300,
          token: { file: "/run/secrets/command-worker-token" },
        };
      }),
      "commandWorker.host must be loopback or a container name",
    ],
    [
      "a command worker with an inline token",
      withChange((config) => {
        config.commandWorker = {
          host: "command-worker",
          port: 7300,
          token: "inline",
        };
      }),
      "commandWorker.token must be an object",
    ],
    [
      "a relative command worker shell",
      withChange((config) => {
        config.commandWorker = {
          host: "command-worker",
          port: 7300,
          token: { file: "/run/secrets/command-worker-token" },
          shell: "bash",
        };
      }),
      "commandWorker.shell must be an absolute path",
    ],
  ])("rejects %s", (_name, config, message) => {
    expect(() => parseAssistantServerConfig(config, "/etc/agentlink")).toThrow(
      message,
    );
  });

  it("accepts plain HTTP to a sibling container with allowInsecureHttp", () => {
    const config = parseAssistantServerConfig(
      withChange((value) => {
        const provider = (
          value.providers as Array<Record<string, unknown>>
        )[0]!;
        provider.baseURL = "http://meridian:3456/v1";
        provider.allowInsecureHttp = true;
      }),
      "/etc/agentlink",
    );
    expect(config.providers[0]).toMatchObject({
      baseURL: "http://meridian:3456/v1",
      allowInsecureHttp: true,
    });
  });

  it("parses a command worker with a default shell", () => {
    const config = parseAssistantServerConfig(
      withChange((value) => {
        value.commandWorker = {
          host: "command-worker",
          port: 7300,
          token: { file: "secrets/command-worker-token" },
        };
      }),
      "/etc/agentlink",
    );
    expect(config.commandWorker).toEqual({
      host: "command-worker",
      port: 7300,
      token: { file: "/etc/agentlink/secrets/command-worker-token" },
      shell: "/bin/bash",
    });
    expect(
      parseAssistantServerConfig(validConfig(), "/etc/agentlink").commandWorker,
    ).toBeUndefined();
  });

  it("accepts a server-managed local CA", () => {
    expect(
      parseAssistantServerConfig(
        withChange((config) => {
          config.tls = { localCa: true };
        }),
        "/etc/agentlink",
      ).tls,
    ).toEqual({ localCa: true });
  });

  it("accepts the shipped Linux and macOS examples", async () => {
    const deploy = path.join(import.meta.dirname, "..", "deploy");
    for (const name of [
      "server.linux.example.json",
      "server.macos.example.json",
      "container/server.example.json",
      "container/server.with-meridian.example.json",
    ]) {
      await expect(
        loadAssistantServerConfig(path.join(deploy, name)),
      ).resolves.toMatchObject({ schemaVersion: 1 });
    }
  });
});

describe("provider secrets", () => {
  it("requires a private, non-empty key file and rereads it on use", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "key");
    await fs.writeFile(file, "first-key\n", { mode: 0o644 });
    await fs.chmod(file, 0o644);
    await expect(prepareSecret({ file }, "apiKey")).rejects.toThrow(
      "must not be readable by group or others",
    );

    await fs.chmod(file, 0o600);
    const read = await prepareSecret({ file }, "apiKey");
    await expect(read()).resolves.toBe("first-key");
    await fs.writeFile(file, "rotated-key\n");
    await expect(read()).resolves.toBe("rotated-key");

    await fs.writeFile(file, "  \n");
    await expect(read()).rejects.toThrow("is empty");
  });

  it("reads systemd credentials from CREDENTIALS_DIRECTORY", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "openai-api-key"), "from-systemd", {
      mode: 0o400,
    });
    await expect(
      prepareSecret({ credential: "openai-api-key" }, "apiKey", {}),
    ).rejects.toThrow("CREDENTIALS_DIRECTORY");
    const read = await prepareSecret(
      { credential: "openai-api-key" },
      "apiKey",
      { CREDENTIALS_DIRECTORY: dir },
    );
    await expect(read()).resolves.toBe("from-systemd");
  });

  it("maps providers to workspace-host providers with lazy keys", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "key");
    await fs.writeFile(file, "sk-test", { mode: 0o600 });
    const config = parseAssistantServerConfig(
      withChange((value) => {
        value.providers = [
          ...(value.providers as unknown[]),
          {
            type: "openai",
            id: "openai",
            modelIds: ["gpt-5.5"],
            apiKey: { file },
          },
        ];
      }),
      dir,
    );
    const [compatible, openai] = await resolveWorkspaceProviders(
      config.providers,
    );
    expect(compatible).toMatchObject({
      type: "openai-compatible",
      id: "local",
      noAuth: true,
    });
    expect(compatible).not.toHaveProperty("resolveApiKey");
    expect(openai).toMatchObject({ type: "openai", modelIds: ["gpt-5.5"] });
    await expect(
      (openai as { resolveApiKey: () => Promise<string> }).resolveApiKey(),
    ).resolves.toBe("sk-test");
  });

  it("maps a codex provider to the server's sign-in credential provider", async () => {
    const config = parseAssistantServerConfig(
      withChange((value) => {
        value.providers = [{ type: "codex", modelIds: ["gpt-6.1-sol"] }];
        value.defaultModel = { providerId: "codex", modelId: "gpt-6.1-sol" };
      }),
      "/etc/agentlink",
    );
    await expect(resolveWorkspaceProviders(config.providers)).rejects.toThrow(
      "no Codex sign-in store",
    );
    const credentialProvider = { resolveAuth: async () => null };
    const [codex] = await resolveWorkspaceProviders(
      config.providers,
      {},
      {
        codexCredentialProvider: credentialProvider,
      },
    );
    expect(codex).toEqual({
      type: "codex",
      modelIds: ["gpt-6.1-sol"],
      credentialProvider,
    });
  });
});
