import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureBrowserGatewayLocalCertificateAuthority } from "./localCertificateAuthority.js";
import forge from "node-forge";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-local-ca-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe("local browser gateway certificate authority", () => {
  it("creates a persistent CA and a localhost/local wildcard gateway certificate", async () => {
    const rootDir = await createTemporaryDirectory();
    const first = await ensureBrowserGatewayLocalCertificateAuthority({
      rootDir,
    });
    const second = await ensureBrowserGatewayLocalCertificateAuthority({
      rootDir,
    });

    expect(second.caCertificatePem).toBe(first.caCertificatePem);
    expect(second.certificatePem).toBe(first.certificatePem);
    expect(await fs.readFile(first.caCertificatePath, "utf-8")).toBe(
      first.caCertificatePem,
    );

    const root = forge.pki.certificateFromPem(first.caCertificatePem);
    const leaf = forge.pki.certificateFromPem(first.certificatePem);
    expect(
      (root.getExtension("basicConstraints") as { cA?: boolean } | undefined)
        ?.cA,
    ).toBe(true);
    expect(root.verify(leaf)).toBe(true);
    expect(
      (
        leaf.getExtension("subjectAltName") as
          | { altNames?: unknown[] }
          | undefined
      )?.altNames,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 2, value: "*.local" }),
        expect.objectContaining({ type: 2, value: "localhost" }),
        expect.objectContaining({ type: 7, ip: "127.0.0.1" }),
      ]),
    );

    const caStat = await fs.stat(first.caCertificatePath);
    const privateKeyStat = await fs.stat(
      path.join(rootDir, "agentlink-local-ca-key.pem"),
    );
    expect(caStat.mode & 0o777).toBe(0o644);
    expect(privateKeyStat.mode & 0o777).toBe(0o600);
  });

  it("replaces an invalid persisted leaf certificate", async () => {
    const rootDir = await createTemporaryDirectory();
    const first = await ensureBrowserGatewayLocalCertificateAuthority({
      rootDir,
    });
    await fs.writeFile(
      path.join(rootDir, "browser-gateway-local.pem"),
      "not a certificate",
      "utf-8",
    );

    const replaced = await ensureBrowserGatewayLocalCertificateAuthority({
      rootDir,
    });
    expect(replaced.caCertificatePem).toBe(first.caCertificatePem);
    expect(replaced.certificatePem).not.toBe("not a certificate");
    expect(() =>
      forge.pki.certificateFromPem(replaced.certificatePem),
    ).not.toThrow();
  });

  it("replaces a persisted leaf key that does not match its certificate", async () => {
    const rootDir = await createTemporaryDirectory();
    const first = await ensureBrowserGatewayLocalCertificateAuthority({
      rootDir,
    });
    const replacementKey = forge.pki.rsa.generateKeyPair(2048).privateKey;
    await fs.writeFile(
      path.join(rootDir, "browser-gateway-local-key.pem"),
      forge.pki.privateKeyToPem(replacementKey),
      { encoding: "utf-8", mode: 0o600 },
    );

    const replaced = await ensureBrowserGatewayLocalCertificateAuthority({
      rootDir,
    });
    expect(replaced.caCertificatePem).toBe(first.caCertificatePem);
    expect(replaced.certificatePem).not.toBe(first.certificatePem);
    expect(
      forge.pki.publicKeyToPem(
        forge.pki.certificateFromPem(replaced.certificatePem).publicKey,
      ),
    ).not.toBe(
      forge.pki.publicKeyToPem(
        forge.pki.rsa.setPublicKey(replacementKey.n, replacementKey.e),
      ),
    );
  });
});
