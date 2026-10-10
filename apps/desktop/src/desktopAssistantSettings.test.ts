import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  assistantSettingsFrom,
  readAssistantConfig,
  updateAssistantSettings,
} from "./desktopAssistantSettings.js";

import { DEFAULT_ASSISTANT_ORIGIN } from "../../../src/shared/assistantAddress.js";
import forge from "node-forge";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function preferencesFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-settings-"));
  cleanup.push(dir);
  return path.join(dir, "desktop-preferences.json");
}

function caPem() {
  const pair = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = pair.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(Date.now() - 1000);
  certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
  const subject = [{ name: "commonName", value: "CA" }];
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.setExtensions([{ name: "basicConstraints", cA: true }]);
  certificate.sign(pair.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(certificate);
}

describe("desktop Assistant settings", () => {
  it("defaults to the mDNS address with nothing pinned", async () => {
    const file = await preferencesFile();
    expect(assistantSettingsFrom(await readAssistantConfig(file))).toEqual({
      origin: DEFAULT_ASSISTANT_ORIGIN,
      defaultOrigin: DEFAULT_ASSISTANT_ORIGIN,
      caFingerprint256: null,
    });
  });

  it("stores the address and CA, keeps the CA when omitted, and removes it on null", async () => {
    const file = await preferencesFile();
    const pinned = await updateAssistantSettings(file, {
      origin: "192.168.50.160:8443/ignored",
      caPem: caPem(),
    });
    expect(pinned.origin).toBe("https://192.168.50.160:8443");
    expect(pinned.ca?.fingerprint256).toMatch(/^[0-9A-F:]+$/u);

    const kept = await updateAssistantSettings(file, {
      origin: "https://framework16.local:8443",
    });
    expect(kept.ca?.fingerprint256).toBe(pinned.ca?.fingerprint256);
    expect((await readAssistantConfig(file)).origin).toBe(
      "https://framework16.local:8443",
    );

    const removed = await updateAssistantSettings(file, {
      origin: kept.origin,
      caPem: null,
    });
    expect(removed.ca).toBeUndefined();
  });

  it("refuses unusable addresses and certificates without changing anything", async () => {
    const file = await preferencesFile();
    await expect(
      updateAssistantSettings(file, { origin: "http://insecure.local" }),
    ).rejects.toThrow("assistant_origin_invalid");
    await expect(
      updateAssistantSettings(file, {
        origin: DEFAULT_ASSISTANT_ORIGIN,
        caPem: "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----",
      }),
    ).rejects.toThrow("assistant_ca_invalid");
    await expect(updateAssistantSettings(file, "nope")).rejects.toThrow(
      "assistant_settings_invalid",
    );
    expect(await readAssistantConfig(file)).toEqual({
      origin: DEFAULT_ASSISTANT_ORIGIN,
    });
  });
});
