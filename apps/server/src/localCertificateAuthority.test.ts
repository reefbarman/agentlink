import forge from "node-forge";
import { X509Certificate, generateKeyPairSync } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureLocalServerCertificate,
  localTlsHostsFromOrigins,
  readLocalCertificateAuthority,
  type LocalTlsHosts,
} from "./localCertificateAuthority.js";

const DAY = 24 * 60 * 60 * 1000;
const LOCAL_HOSTS: LocalTlsHosts = {
  dnsNames: ["localhost"],
  ipAddresses: ["127.0.0.1"],
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function tempDirectory(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-ca-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, "tls");
}

/** Serve `cert`/`key` and complete a verifying TLS handshake against `ca`. */
async function handshake(input: {
  readonly cert: string;
  readonly key: string;
  readonly ca: string;
  readonly host?: string;
  readonly servername?: string;
}): Promise<tls.PeerCertificate> {
  const server = tls.createServer({ cert: input.cert, key: input.key }, (s) =>
    s.end(),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: input.host ?? "127.0.0.1",
        port,
        ca: input.ca,
        ...(input.servername ? { servername: input.servername } : {}),
      });
      socket.once("secureConnect", () => {
        const peer = socket.getPeerCertificate();
        socket.destroy();
        resolve(peer);
      });
      socket.once("error", reject);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A certificate for arbitrary names, signed directly with the CA key. */
async function rogueLeaf(
  directory: string,
  altNames: Array<{ type: number; value?: string; ip?: string }>,
): Promise<{ cert: string; key: string }> {
  const caCertificate = forge.pki.certificateFromPem(
    await fs.readFile(path.join(directory, "ca.pem"), "utf8"),
  );
  const caKey = forge.pki.privateKeyFromPem(
    await fs.readFile(path.join(directory, "ca-key.pem"), "utf8"),
  );
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.publicKeyFromPem(keys.publicKey);
  certificate.serialNumber = "7f01";
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + DAY);
  certificate.setSubject([{ name: "commonName", value: "rogue" }]);
  certificate.setIssuer(caCertificate.subject.attributes);
  certificate.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames },
  ]);
  certificate.sign(caKey, forge.md.sha256.create());
  return {
    cert: forge.pki.certificateToPem(certificate),
    key: keys.privateKey,
  };
}

describe("local certificate authority", () => {
  it("derives normalised hosts from public origins", () => {
    expect(
      localTlsHostsFromOrigins([
        "https://Framework.local:8443",
        "https://192.168.50.160:8443",
        "https://[::1]:8443",
        "https://framework.local",
      ]),
    ).toEqual({
      dnsNames: ["framework.local"],
      ipAddresses: ["192.168.50.160", "::1"],
    });
  });

  it("creates a private CA and a server certificate browsers can verify", async () => {
    const directory = await tempDirectory();
    const issued = await ensureLocalServerCertificate({
      directory,
      hosts: LOCAL_HOSTS,
    });
    expect(issued).toMatchObject({ createdCa: true, issuedLeaf: true });
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    for (const [file, mode] of [
      ["ca-key.pem", 0o600],
      ["server-key.pem", 0o600],
      ["ca.pem", 0o644],
      ["server.pem", 0o644],
    ] as const) {
      expect((await fs.stat(path.join(directory, file))).mode & 0o777).toBe(
        mode,
      );
    }
    const ca = new X509Certificate(issued.caCertificatePem);
    expect(ca.ca).toBe(true);
    expect(issued.caFingerprint256).toBe(ca.fingerprint256);
    const leaf = new X509Certificate(issued.certificatePem);
    expect(leaf.ca).toBe(false);
    expect(leaf.subjectAltName).toBe("DNS:localhost, IP Address:127.0.0.1");
    expect(leaf.verify(ca.publicKey)).toBe(true);
    // Under Apple's limit for trusted server certificates (825 days).
    expect(issued.notAfter.getTime() - Date.now()).toBeLessThanOrEqual(
      366 * DAY,
    );

    const tlsFiles = {
      cert: issued.certificatePem,
      key: issued.privateKeyPem,
      ca: issued.caCertificatePem,
    };
    await expect(
      handshake({ ...tlsFiles, servername: "localhost" }),
    ).resolves.toBeTruthy();
    // Verified by IP address too (no servername).
    await expect(handshake(tlsFiles)).resolves.toBeTruthy();

    // Control for the constraint tests below: the same hand-built
    // certificate is accepted when it names a permitted host.
    const permitted = await rogueLeaf(directory, [
      { type: 2, value: "localhost" },
    ]);
    await expect(
      handshake({
        ...permitted,
        ca: issued.caCertificatePem,
        servername: "localhost",
      }),
    ).resolves.toBeTruthy();
  });

  it.each([
    ["with a hostname and an IP", LOCAL_HOSTS],
    ["with only an IP", { dnsNames: [], ipAddresses: ["127.0.0.1"] }],
    ["with only a hostname", { dnsNames: ["localhost"], ipAddresses: [] }],
  ])(
    "cannot vouch for any other name or address %s",
    async (_label, hosts: LocalTlsHosts) => {
      const directory = await tempDirectory();
      const issued = await ensureLocalServerCertificate({ directory, hosts });
      // Even with the CA key, a certificate for another site fails chain
      // validation because of the CA's name constraints.
      const otherSite = await rogueLeaf(directory, [
        { type: 2, value: "example.com" },
      ]);
      await expect(
        handshake({
          ...otherSite,
          ca: issued.caCertificatePem,
          servername: "example.com",
        }),
      ).rejects.toThrow(/subtree|violation/iu);
      const otherAddress = await rogueLeaf(directory, [
        { type: 7, ip: "10.1.2.3" },
      ]);
      await expect(
        handshake({
          ...otherAddress,
          ca: issued.caCertificatePem,
          host: "127.0.0.1",
          servername: undefined,
        }),
      ).rejects.toThrow(/subtree|violation/iu);
    },
  );

  it("reuses a current certificate and renews it within 30 days of expiry", async () => {
    const directory = await tempDirectory();
    const clock = { value: Date.now() };
    const first = await ensureLocalServerCertificate({
      directory,
      hosts: LOCAL_HOSTS,
      now: () => clock.value,
    });
    const again = await ensureLocalServerCertificate({
      directory,
      hosts: LOCAL_HOSTS,
      now: () => clock.value,
    });
    expect(again).toMatchObject({ createdCa: false, issuedLeaf: false });
    expect(again.certificatePem).toBe(first.certificatePem);

    clock.value = first.notAfter.getTime() - 29 * DAY;
    const renewed = await ensureLocalServerCertificate({
      directory,
      hosts: LOCAL_HOSTS,
      now: () => clock.value,
    });
    expect(renewed).toMatchObject({ createdCa: false, issuedLeaf: true });
    expect(renewed.caFingerprint256).toBe(first.caFingerprint256);
    expect(renewed.notAfter.getTime()).toBeGreaterThan(
      first.notAfter.getTime(),
    );
    expect(
      new X509Certificate(renewed.certificatePem).verify(
        new X509Certificate(first.caCertificatePem).publicKey,
      ),
    ).toBe(true);
  });

  it("refuses to replace a CA devices may trust", async () => {
    const directory = await tempDirectory();
    const issued = await ensureLocalServerCertificate({
      directory,
      hosts: LOCAL_HOSTS,
    });
    const caPath = path.join(directory, "ca.pem");
    const keyPath = path.join(directory, "ca-key.pem");

    // Different hosts: the CA cannot cover them and is not silently replaced.
    await expect(
      ensureLocalServerCertificate({
        directory,
        hosts: { dnsNames: ["framework.local"], ipAddresses: ["127.0.0.1"] },
      }),
    ).rejects.toMatchObject({ code: "ca_hosts_changed" });
    expect(await fs.readFile(caPath, "utf8")).toBe(issued.caCertificatePem);

    // Expired.
    await expect(
      ensureLocalServerCertificate({
        directory,
        hosts: LOCAL_HOSTS,
        now: () => Date.now() + 3_651 * DAY,
      }),
    ).rejects.toMatchObject({ code: "ca_expired" });

    // The key bundle is authoritative: a lost or damaged public copy is
    // restored from it, with the same CA.
    const bundle = await fs.readFile(keyPath, "utf8");
    expect(bundle).toContain("PRIVATE KEY");
    expect(bundle).toContain(issued.caCertificatePem);
    for (const damage of [
      () => fs.rm(caPath),
      () => fs.writeFile(caPath, "not a certificate"),
    ]) {
      await damage();
      const restored = await ensureLocalServerCertificate({
        directory,
        hosts: LOCAL_HOSTS,
      });
      expect(restored).toMatchObject({
        createdCa: false,
        caFingerprint256: issued.caFingerprint256,
      });
      expect(await fs.readFile(caPath, "utf8")).toBe(issued.caCertificatePem);
    }

    // A damaged bundle, or a lost key with the public copy still present,
    // fails closed: never a silent new trust anchor.
    await fs.writeFile(keyPath, bundle.replace(/MII/u, "XXX"));
    await expect(
      ensureLocalServerCertificate({ directory, hosts: LOCAL_HOSTS }),
    ).rejects.toMatchObject({ code: "ca_unreadable" });
    await fs.rm(keyPath);
    await expect(
      readLocalCertificateAuthority({ directory, hosts: LOCAL_HOSTS }),
    ).rejects.toMatchObject({ code: "ca_unreadable" });
    await expect(
      ensureLocalServerCertificate({ directory, hosts: LOCAL_HOSTS }),
    ).rejects.toMatchObject({ code: "ca_unreadable" });
    expect(await fs.readFile(caPath, "utf8")).toBe(issued.caCertificatePem);
  });

  it("reissues a damaged or mismatched server certificate under the same CA", async () => {
    const directory = await tempDirectory();
    const issued = await ensureLocalServerCertificate({
      directory,
      hosts: LOCAL_HOSTS,
    });
    await fs.writeFile(path.join(directory, "server.pem"), "damaged");
    const reissued = await ensureLocalServerCertificate({
      directory,
      hosts: LOCAL_HOSTS,
    });
    expect(reissued).toMatchObject({ createdCa: false, issuedLeaf: true });
    expect(reissued.caFingerprint256).toBe(issued.caFingerprint256);

    // A key that does not match the certificate is also reissued.
    await fs.writeFile(
      path.join(directory, "server-key.pem"),
      generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey,
    );
    await expect(
      ensureLocalServerCertificate({ directory, hosts: LOCAL_HOSTS }),
    ).resolves.toMatchObject({ issuedLeaf: true });
  });
});
