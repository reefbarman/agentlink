import { X509Certificate } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startAssistantService,
  type AssistantService,
} from "./assistantService.js";
import { parseAssistantServerConfig } from "./serverConfig.js";
import { freePort } from "./testSupport.js";

const DAY = 24 * 60 * 60 * 1000;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/**
 * Complete a TLS handshake trusting only `ca` and return the server
 * certificate. `verify: false` skips OpenSSL's checks (used when the test
 * clock is in the future, so the real clock sees "not yet valid"); callers
 * then check the CA signature themselves.
 */
function peerCertificate(
  port: number,
  ca: string,
  verify = true,
): Promise<tls.PeerCertificate> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: "127.0.0.1",
      port,
      servername: "localhost",
      ca,
      rejectUnauthorized: verify,
    });
    socket.once("secureConnect", () => {
      const peer = socket.getPeerCertificate();
      socket.destroy();
      resolve(peer);
    });
    socket.once("error", reject);
  });
}

describe("assistant service local certificates", () => {
  it("renews the server certificate in the running listener", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-svc-"));
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, "projects", "home"), { recursive: true });
    const port = await freePort();
    const config = parseAssistantServerConfig(
      {
        schemaVersion: 1,
        dataRoot: "data",
        listen: { host: "127.0.0.1", port },
        publicOrigins: [`https://localhost:${port}`],
        tls: { localCa: true },
        defaultModel: { providerId: "local", modelId: "fixture" },
        providers: [
          {
            type: "openai-compatible",
            id: "local",
            baseURL: "http://127.0.0.1:9/v1",
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
        projects: [{ id: "home", root: "projects/home" }],
      },
      root,
    );
    const clock = { value: Date.now() };
    const log: string[] = [];
    const service: AssistantService = await startAssistantService({
      config,
      log: (line) => log.push(line),
      now: () => clock.value,
      certificateCheckIntervalMs: 25,
    });
    cleanup.push(() => service.close());

    const ca = await fs.readFile(
      path.join(root, "data", "tls", "ca.pem"),
      "utf8",
    );
    const first = await peerCertificate(port, ca);
    expect(log.join("\n")).toContain("Created a local certificate authority");

    // A second service on the same data root cannot touch the certificates.
    await expect(
      startAssistantService({ config, log: () => undefined }),
    ).rejects.toThrow(/Another agentlink-server process is using/u);
    expect((await peerCertificate(port, ca)).serialNumber).toBe(
      first.serialNumber,
    );

    // Nothing changes while the certificate is current.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await peerCertificate(port, ca)).serialNumber).toBe(
      first.serialNumber,
    );

    // Near expiry, the running server picks up a renewed certificate from
    // the same CA without a restart.
    clock.value = new Date(first.valid_to).getTime() - 10 * DAY;
    const caKey = new X509Certificate(ca).publicKey;
    await vi.waitFor(
      async () => {
        const renewed = await peerCertificate(port, ca, false);
        expect(renewed.serialNumber).not.toBe(first.serialNumber);
        expect(new X509Certificate(renewed.raw).verify(caKey)).toBe(true);
        expect(new Date(renewed.valid_to).getTime()).toBeGreaterThan(
          new Date(first.valid_to).getTime(),
        );
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(
      log.filter((line) => line.startsWith("Issued server certificate")),
    ).toHaveLength(2);
  }, 30_000);
});
