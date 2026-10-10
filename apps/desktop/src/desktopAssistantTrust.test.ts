import {
  AssistantCaError,
  isTrustedAssistantCertificate,
  parseAssistantCa,
} from "./desktopAssistantTrust.js";
import { describe, expect, it } from "vitest";

import forge from "node-forge";

const NOW = Date.UTC(2026, 9, 10);
const DAY = 24 * 60 * 60 * 1000;

function keys() {
  return forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
}

function makeCa(name = "AgentLink Assistant CA") {
  const pair = keys();
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = pair.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(NOW - DAY);
  certificate.validity.notAfter = new Date(NOW + 365 * DAY);
  const subject = [{ name: "commonName", value: name }];
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
  ]);
  certificate.sign(pair.privateKey, forge.md.sha256.create());
  return {
    certificate,
    privateKey: pair.privateKey,
    pem: forge.pki.certificateToPem(certificate),
  };
}

function makeLeaf(
  ca: ReturnType<typeof makeCa>,
  options: { dns?: string; ip?: string; notAfter?: number } = {},
) {
  const pair = keys();
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = pair.publicKey;
  certificate.serialNumber = "02";
  certificate.validity.notBefore = new Date(NOW - DAY);
  certificate.validity.notAfter = new Date(options.notAfter ?? NOW + 30 * DAY);
  certificate.setSubject([{ name: "commonName", value: "assistant" }]);
  certificate.setIssuer(ca.certificate.subject.attributes);
  certificate.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: options.dns ?? "agentlink-assistant.local" },
        { type: 7, ip: options.ip ?? "192.168.50.160" },
      ],
    },
  ]);
  certificate.sign(ca.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(certificate);
}

describe("Assistant certificate pinning", () => {
  const ca = makeCa();
  const pinned = parseAssistantCa(ca.pem);
  const leaf = makeLeaf(ca);

  it("parses a CA and reports its fingerprint the way the server prints it", () => {
    expect(pinned.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/u);
    for (const bad of [leaf, "not a pem", 42, "x".repeat(70_000)]) {
      expect(() => parseAssistantCa(bad)).toThrow(AssistantCaError);
    }
  });

  it("accepts the CA's current leaf for its hostname and IP address", () => {
    for (const hostname of ["agentlink-assistant.local", "192.168.50.160"]) {
      expect(
        isTrustedAssistantCertificate({
          leafPem: leaf,
          ca: pinned,
          hostname,
          now: NOW,
        }),
      ).toBe(true);
    }
  });

  it("refuses another CA's leaf, other hosts, expired leaves and CAs as leaves", () => {
    const other = makeCa("Someone else");
    const cases = [
      { leafPem: makeLeaf(other), hostname: "agentlink-assistant.local" },
      { leafPem: leaf, hostname: "evil.example" },
      { leafPem: leaf, hostname: "192.168.50.161" },
      {
        leafPem: makeLeaf(ca, { notAfter: NOW - 1000 }),
        hostname: "agentlink-assistant.local",
      },
      { leafPem: ca.pem, hostname: "agentlink-assistant.local" },
      { leafPem: "garbage", hostname: "agentlink-assistant.local" },
    ];
    for (const input of cases) {
      expect(
        isTrustedAssistantCertificate({ ...input, ca: pinned, now: NOW }),
      ).toBe(false);
    }
  });
});
