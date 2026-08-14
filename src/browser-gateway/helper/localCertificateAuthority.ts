import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import forge from "node-forge";

const LOCAL_CA_DIRECTORY = "browser-gateway-ca";
const ROOT_CERTIFICATE_FILE = "agentlink-local-ca.pem";
const ROOT_PRIVATE_KEY_FILE = "agentlink-local-ca-key.pem";
const LEAF_CERTIFICATE_FILE = "browser-gateway-local.pem";
const LEAF_PRIVATE_KEY_FILE = "browser-gateway-local-key.pem";
const ROOT_VALIDITY_DAYS = 3_650;
const LEAF_VALIDITY_DAYS = 365;
const RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export interface BrowserGatewayLocalCertificate {
  caCertificatePath: string;
  caCertificatePem: string;
  certificatePem: string;
  privateKeyPem: string;
}

export interface LocalCertificateAuthorityOptions {
  rootDir?: string;
  now?: () => Date;
}

type CertificateAuthority = {
  certificate: forge.pki.Certificate;
  certificatePem: string;
  privateKey: forge.pki.rsa.PrivateKey;
  privateKeyPem: string;
};

function defaultRootDir(): string {
  return path.join(os.homedir(), ".agentlink", LOCAL_CA_DIRECTORY);
}

function randomSerialNumber(): string {
  return forge.util.bytesToHex(forge.random.getBytesSync(16));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1_000);
}

function isUsableCertificate(
  certificate: forge.pki.Certificate,
  now: Date,
): boolean {
  return (
    certificate.validity.notBefore <= now && certificate.validity.notAfter > now
  );
}

function privateKeyMatchesCertificate(
  privateKey: forge.pki.rsa.PrivateKey,
  certificate: forge.pki.Certificate,
): boolean {
  return (
    forge.pki.publicKeyToPem(
      forge.pki.rsa.setPublicKey(privateKey.n, privateKey.e),
    ) === forge.pki.publicKeyToPem(certificate.publicKey)
  );
}

async function readPem(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writePrivatePem(filePath: string, pem: string): Promise<void> {
  await fs.writeFile(filePath, pem, { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function writePublicPem(filePath: string, pem: string): Promise<void> {
  await fs.writeFile(filePath, pem, { encoding: "utf-8", mode: 0o644 });
  await fs.chmod(filePath, 0o644).catch(() => undefined);
}

function buildRootAuthority(now: Date): CertificateAuthority {
  const keyPair = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keyPair.publicKey;
  certificate.serialNumber = randomSerialNumber();
  certificate.validity.notBefore = new Date(now.getTime() - 60_000);
  certificate.validity.notAfter = addDays(now, ROOT_VALIDITY_DAYS);
  const attributes = [
    { name: "commonName", value: "AgentLink Local CA" },
    { name: "organizationName", value: "AgentLink" },
  ];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    {
      name: "keyUsage",
      keyCertSign: true,
      cRLSign: true,
      critical: true,
    },
    { name: "subjectKeyIdentifier" },
  ]);
  certificate.sign(keyPair.privateKey, forge.md.sha256.create());
  return {
    certificate,
    certificatePem: forge.pki.certificateToPem(certificate),
    privateKey: keyPair.privateKey,
    privateKeyPem: forge.pki.privateKeyToPem(keyPair.privateKey),
  };
}

async function ensureCertificateAuthority(
  rootDir: string,
  now: Date,
): Promise<CertificateAuthority> {
  const certificatePath = path.join(rootDir, ROOT_CERTIFICATE_FILE);
  const privateKeyPath = path.join(rootDir, ROOT_PRIVATE_KEY_FILE);
  const [certificatePem, privateKeyPem] = await Promise.all([
    readPem(certificatePath),
    readPem(privateKeyPath),
  ]);
  if (certificatePem && privateKeyPem) {
    try {
      const certificate = forge.pki.certificateFromPem(certificatePem);
      const privateKey = forge.pki.privateKeyFromPem(
        privateKeyPem,
      ) as forge.pki.rsa.PrivateKey;
      if (
        isUsableCertificate(certificate, now) &&
        privateKeyMatchesCertificate(privateKey, certificate)
      ) {
        return { certificate, certificatePem, privateKey, privateKeyPem };
      }
    } catch {
      // Replace an invalid local CA pair before the gateway can serve it.
    }
  }

  const authority = buildRootAuthority(now);
  await Promise.all([
    writePublicPem(certificatePath, authority.certificatePem),
    writePrivatePem(privateKeyPath, authority.privateKeyPem),
  ]);
  return authority;
}

function buildLeafCertificate(
  authority: CertificateAuthority,
  now: Date,
): { certificatePem: string; privateKeyPem: string } {
  const keyPair = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keyPair.publicKey;
  certificate.serialNumber = randomSerialNumber();
  certificate.validity.notBefore = new Date(now.getTime() - 60_000);
  certificate.validity.notAfter = addDays(now, LEAF_VALIDITY_DAYS);
  certificate.setSubject([
    { name: "commonName", value: "AgentLink Browser Gateway" },
    { name: "organizationName", value: "AgentLink" },
  ]);
  certificate.setIssuer(authority.certificate.subject.attributes);
  certificate.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    {
      name: "extKeyUsage",
      serverAuth: true,
      clientAuth: false,
    },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: "*.local" },
        { type: 2, value: "localhost" },
        { type: 7, ip: "127.0.0.1" },
        { type: 7, ip: "::1" },
      ],
    },
    { name: "subjectKeyIdentifier" },
    {
      name: "authorityKeyIdentifier",
      keyIdentifier: authority.certificate
        .generateSubjectKeyIdentifier()
        .getBytes(),
    },
  ]);
  certificate.sign(authority.privateKey, forge.md.sha256.create());
  return {
    certificatePem: forge.pki.certificateToPem(certificate),
    privateKeyPem: forge.pki.privateKeyToPem(keyPair.privateKey),
  };
}

async function ensureLeafCertificate(
  rootDir: string,
  authority: CertificateAuthority,
  now: Date,
): Promise<{ certificatePem: string; privateKeyPem: string }> {
  const certificatePath = path.join(rootDir, LEAF_CERTIFICATE_FILE);
  const privateKeyPath = path.join(rootDir, LEAF_PRIVATE_KEY_FILE);
  const [certificatePem, privateKeyPem] = await Promise.all([
    readPem(certificatePath),
    readPem(privateKeyPath),
  ]);
  if (certificatePem && privateKeyPem) {
    try {
      const certificate = forge.pki.certificateFromPem(certificatePem);
      const privateKey = forge.pki.privateKeyFromPem(
        privateKeyPem,
      ) as forge.pki.rsa.PrivateKey;
      if (
        certificate.validity.notBefore <= now &&
        certificate.validity.notAfter.getTime() - now.getTime() >
          RENEWAL_WINDOW_MS &&
        authority.certificate.verify(certificate) &&
        privateKeyMatchesCertificate(privateKey, certificate)
      ) {
        return { certificatePem, privateKeyPem };
      }
    } catch {
      // Regenerate a malformed or expired leaf certificate.
    }
  }

  const leaf = buildLeafCertificate(authority, now);
  await Promise.all([
    writePublicPem(certificatePath, leaf.certificatePem),
    writePrivatePem(privateKeyPath, leaf.privateKeyPem),
  ]);
  return leaf;
}

/**
 * Ensures the browser gateway has a persistent local CA and a `.local` server
 * certificate. The returned CA PEM is intentionally public so callers can give
 * users a path to install on devices they pair with the gateway.
 */
export async function ensureBrowserGatewayLocalCertificateAuthority(
  options: LocalCertificateAuthorityOptions = {},
): Promise<BrowserGatewayLocalCertificate> {
  const rootDir = options.rootDir ?? defaultRootDir();
  const now = options.now?.() ?? new Date();
  await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
  await fs.chmod(rootDir, 0o700).catch(() => undefined);

  const authority = await ensureCertificateAuthority(rootDir, now);
  const leaf = await ensureLeafCertificate(rootDir, authority, now);
  return {
    caCertificatePath: path.join(rootDir, ROOT_CERTIFICATE_FILE),
    caCertificatePem: authority.certificatePem,
    certificatePem: leaf.certificatePem,
    privateKeyPem: leaf.privateKeyPem,
  };
}
