import { X509Certificate, generateKeyPairSync, randomBytes } from "node:crypto";

import forge from "node-forge";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { writeFileAtomic } from "./atomicFile.js";

const CA_CERT_FILE = "ca.pem";
const CA_KEY_FILE = "ca-key.pem";
const LEAF_CERT_FILE = "server.pem";
const LEAF_KEY_FILE = "server-key.pem";
const DAY_MS = 24 * 60 * 60 * 1000;
const CA_VALIDITY_MS = 3_650 * DAY_MS;
/** Under Apple's 825-day limit for trusted TLS server certificates. */
const LEAF_VALIDITY_MS = 365 * DAY_MS;
export const LOCAL_LEAF_RENEWAL_WINDOW_MS = 30 * DAY_MS;
const NAME_CONSTRAINTS_OID = "2.5.29.30";
/**
 * RFC 6761 reserved name that never resolves. Used as the only permitted DNS
 * name when no hostname is configured, so DNS names stay constrained too:
 * a name type without a permitted subtree would be unrestricted.
 */
const NO_DNS_NAMES = "invalid";
const NO_IP_ADDRESSES = "0.0.0.0";

/** Names the server is reached by, taken from its public origins. */
export interface LocalTlsHosts {
  readonly dnsNames: readonly string[];
  readonly ipAddresses: readonly string[];
}

export type LocalCertificateAuthorityErrorCode =
  | "ca_missing"
  | "ca_unreadable"
  | "ca_expired"
  | "ca_hosts_changed";

export class LocalCertificateAuthorityError extends Error {
  constructor(
    readonly code: LocalCertificateAuthorityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LocalCertificateAuthorityError";
  }
}

export interface LocalServerCertificate {
  readonly caCertificatePem: string;
  /** SHA-256 fingerprint, colon-separated hex, for checking on each device. */
  readonly caFingerprint256: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly notAfter: Date;
  readonly createdCa: boolean;
  readonly issuedLeaf: boolean;
}

export interface LocalCertificateAuthorityOptions {
  /** Private directory owned by the service account, created `0700`. */
  readonly directory: string;
  readonly hosts: LocalTlsHosts;
  readonly now?: () => number;
}

interface Authority {
  readonly certificate: forge.pki.Certificate;
  readonly certificatePem: string;
  readonly privateKey: forge.pki.rsa.PrivateKey;
}

/**
 * Derive the hosts to certify from `https://` public origins. Hostnames are
 * lowercased; IPv6 brackets are removed. Order is normalised so equivalent
 * configurations produce identical constraints.
 */
export function localTlsHostsFromOrigins(
  origins: readonly string[],
): LocalTlsHosts {
  const dnsNames = new Set<string>();
  const ipAddresses = new Set<string>();
  for (const origin of origins) {
    const hostname = new URL(origin).hostname
      .replace(/^\[|\]$/gu, "")
      .toLowerCase();
    if (net.isIP(hostname)) ipAddresses.add(hostname);
    else dnsNames.add(hostname);
  }
  return {
    dnsNames: [...dnsNames].sort(),
    ipAddresses: [...ipAddresses].sort(),
  };
}

/**
 * Ensure a name-constrained local CA and a current server certificate.
 *
 * The CA is created once. It can only vouch for the configured hostnames
 * (and names under them, which is how DNS name constraints work) and the
 * exact configured IP addresses, so a device that trusts it cannot be fooled
 * for any other site even if the CA key leaks. It is never replaced
 * silently: devices trust it, so a damaged, expired, or mismatched CA is an
 * error the operator resolves. The server certificate is reissued when
 * missing, damaged, for different hosts, or within 30 days of expiry.
 *
 * Callers that may run concurrently must serialise calls for one directory
 * (the service holds a lock file for its lifetime).
 */
export async function ensureLocalServerCertificate(
  options: LocalCertificateAuthorityOptions,
): Promise<LocalServerCertificate> {
  const now = new Date((options.now ?? Date.now)());
  await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
  await fs.chmod(options.directory, 0o700);

  let createdCa = false;
  let authority = await loadAuthority(options.directory, options.hosts, now);
  if (!authority) {
    authority = createAuthority(options.hosts, now);
    // The key bundle (key and certificate together) is written with one
    // atomic rename: that rename is the commit point of creation.
    await writeFileAtomic(
      path.join(options.directory, CA_KEY_FILE),
      `${forge.pki.privateKeyToPem(authority.privateKey)}${authority.certificatePem}`,
      0o600,
    );
    createdCa = true;
  }
  // `ca.pem` is only a public copy of the bundle's certificate.
  const publicPath = path.join(options.directory, CA_CERT_FILE);
  if ((await readOptional(publicPath)) !== authority.certificatePem) {
    await writeFileAtomic(publicPath, authority.certificatePem, 0o644);
  }

  let leaf = await loadLeaf(options.directory, authority, options.hosts, now);
  let issuedLeaf = false;
  if (!leaf) {
    leaf = issueLeaf(authority, options.hosts, now);
    await writeFileAtomic(
      path.join(options.directory, LEAF_KEY_FILE),
      leaf.privateKeyPem,
      0o600,
    );
    await writeFileAtomic(
      path.join(options.directory, LEAF_CERT_FILE),
      leaf.certificatePem,
      0o644,
    );
    issuedLeaf = true;
  }

  return {
    caCertificatePem: authority.certificatePem,
    caFingerprint256: fingerprint(authority.certificatePem),
    certificatePem: leaf.certificatePem,
    privateKeyPem: leaf.privateKeyPem,
    notAfter: leaf.notAfter,
    createdCa,
    issuedLeaf,
  };
}

/**
 * Read and validate the existing CA without creating anything. Returns
 * undefined when no CA exists yet. Used by `--check` and `export-ca`.
 */
export async function readLocalCertificateAuthority(options: {
  readonly directory: string;
  readonly hosts: LocalTlsHosts;
  readonly now?: () => number;
}): Promise<
  | { readonly certificatePem: string; readonly fingerprint256: string }
  | undefined
> {
  const authority = await loadAuthority(
    options.directory,
    options.hosts,
    new Date((options.now ?? Date.now)()),
  );
  return authority
    ? {
        certificatePem: authority.certificatePem,
        fingerprint256: fingerprint(authority.certificatePem),
      }
    : undefined;
}

async function loadAuthority(
  directory: string,
  hosts: LocalTlsHosts,
  now: Date,
): Promise<Authority | undefined> {
  const [bundlePem, publicPem] = await Promise.all([
    readOptional(path.join(directory, CA_KEY_FILE)),
    readOptional(path.join(directory, CA_CERT_FILE)),
  ]);
  const damaged = new LocalCertificateAuthorityError(
    "ca_unreadable",
    `The local CA in ${directory} is incomplete or damaged. It is not replaced automatically because devices trust it. Move ${directory} aside to create a new CA, then install the new CA on every device.`,
  );
  if (bundlePem === undefined) {
    // A public certificate without its key bundle means the key was lost
    // after the CA existed: devices may trust it, so fail closed.
    if (publicPem !== undefined) throw damaged;
    return undefined;
  }
  let certificate: forge.pki.Certificate;
  let privateKey: forge.pki.rsa.PrivateKey;
  try {
    const blocks = forge.pem.decode(bundlePem);
    const keyBlock = blocks.find((block) => block.type === "RSA PRIVATE KEY");
    const certificateBlock = blocks.find(
      (block) => block.type === "CERTIFICATE",
    );
    if (!keyBlock || !certificateBlock || blocks.length !== 2) throw damaged;
    privateKey = forge.pki.privateKeyFromPem(
      forge.pem.encode(keyBlock),
    ) as forge.pki.rsa.PrivateKey;
    certificate = forge.pki.certificateFromPem(
      forge.pem.encode(certificateBlock),
    );
  } catch {
    throw damaged;
  }
  const certificatePem = forge.pki.certificateToPem(certificate);
  if (!keyMatches(privateKey, certificate)) throw damaged;
  if (certificate.validity.notAfter <= now) {
    throw new LocalCertificateAuthorityError(
      "ca_expired",
      `The local CA in ${directory} expired on ${certificate.validity.notAfter.toISOString()}. Move ${directory} aside to create a new CA, then install it on every device.`,
    );
  }
  const constraints = certificate.extensions.find(
    (extension: { id?: string }) => extension.id === NAME_CONSTRAINTS_OID,
  ) as { value?: unknown } | undefined;
  if (
    constraints?.value !== forge.asn1.toDer(nameConstraints(hosts)).getBytes()
  ) {
    throw new LocalCertificateAuthorityError(
      "ca_hosts_changed",
      `The local CA in ${directory} only covers a different set of hosts than publicOrigins (${describeHosts(hosts)}). Restore the earlier publicOrigins, or move ${directory} aside to create a CA for the new hosts and install it on every device.`,
    );
  }
  return { certificate, certificatePem, privateKey };
}

function createAuthority(hosts: LocalTlsHosts, now: Date): Authority {
  const { certificate, privateKey } = newCertificate(
    now,
    new Date(now.getTime() + CA_VALIDITY_MS),
  );
  const label = hosts.dnsNames[0] ?? hosts.ipAddresses[0] ?? "server";
  const attributes = [
    {
      name: "commonName",
      value: `AgentLink Server CA ${label} ${now.toISOString().slice(0, 10)}`,
    },
    { name: "organizationName", value: "AgentLink" },
  ];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.setExtensions([
    {
      name: "basicConstraints",
      cA: true,
      pathLenConstraint: 0,
      critical: true,
    },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { id: NAME_CONSTRAINTS_OID, critical: true, value: nameConstraints(hosts) },
    { name: "subjectKeyIdentifier" },
  ]);
  certificate.sign(privateKey, forge.md.sha256.create());
  return {
    certificate,
    certificatePem: forge.pki.certificateToPem(certificate),
    privateKey,
  };
}

interface Leaf {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly notAfter: Date;
}

async function loadLeaf(
  directory: string,
  authority: Authority,
  hosts: LocalTlsHosts,
  now: Date,
): Promise<Leaf | undefined> {
  const [certificatePem, privateKeyPem] = await Promise.all([
    readOptional(path.join(directory, LEAF_CERT_FILE)),
    readOptional(path.join(directory, LEAF_KEY_FILE)),
  ]);
  if (certificatePem === undefined || privateKeyPem === undefined) {
    return undefined;
  }
  try {
    const certificate = forge.pki.certificateFromPem(certificatePem);
    const privateKey = forge.pki.privateKeyFromPem(
      privateKeyPem,
    ) as forge.pki.rsa.PrivateKey;
    const usable =
      certificate.validity.notBefore <= now &&
      certificate.validity.notAfter.getTime() - now.getTime() >
        LOCAL_LEAF_RENEWAL_WINDOW_MS &&
      authority.certificate.verify(certificate) &&
      keyMatches(privateKey, certificate) &&
      sameAltNames(certificate, hosts);
    return usable
      ? {
          certificatePem,
          privateKeyPem,
          notAfter: certificate.validity.notAfter,
        }
      : undefined;
  } catch {
    // A damaged server certificate is simply reissued.
    return undefined;
  }
}

function issueLeaf(
  authority: Authority,
  hosts: LocalTlsHosts,
  now: Date,
): Leaf {
  const notAfter = new Date(
    Math.min(
      now.getTime() + LEAF_VALIDITY_MS,
      authority.certificate.validity.notAfter.getTime(),
    ),
  );
  const { certificate, privateKey } = newCertificate(now, notAfter);
  certificate.setSubject([
    {
      name: "commonName",
      value: hosts.dnsNames[0] ?? hosts.ipAddresses[0] ?? "server",
    },
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
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: altNames(hosts) },
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
    privateKeyPem: forge.pki.privateKeyToPem(privateKey),
    notAfter,
  };
}

function newCertificate(
  now: Date,
  notAfter: Date,
): {
  certificate: forge.pki.Certificate;
  privateKey: forge.pki.rsa.PrivateKey;
} {
  // Native key generation; node-forge's pure-JS RSA is far slower.
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.publicKeyFromPem(keys.publicKey);
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01; // positive and non-zero
  certificate.serialNumber = serial.toString("hex");
  certificate.validity.notBefore = new Date(now.getTime() - 60_000);
  certificate.validity.notAfter = notAfter;
  return {
    certificate,
    privateKey: forge.pki.privateKeyFromPem(
      keys.privateKey,
    ) as forge.pki.rsa.PrivateKey,
  };
}

/**
 * NameConstraints with permitted subtrees for the configured names (RFC 5280
 * 4.2.1.10): each hostname and the names under it, and each IP address
 * exactly (full-length mask). Both DNS and IP subtrees are always present so
 * neither name type is left unrestricted.
 */
function nameConstraints(hosts: LocalTlsHosts): forge.asn1.Asn1 {
  const { asn1 } = forge;
  const subtree = (base: forge.asn1.Asn1) =>
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [base]);
  const dnsNames = hosts.dnsNames.length > 0 ? hosts.dnsNames : [NO_DNS_NAMES];
  const ipAddresses =
    hosts.ipAddresses.length > 0 ? hosts.ipAddresses : [NO_IP_ADDRESSES];
  const subtrees = [
    ...dnsNames.map((name) =>
      subtree(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 2, false, name)),
    ),
    ...ipAddresses.map((address) => {
      const bytes = ipBytes(address);
      const mask = String.fromCharCode(0xff).repeat(bytes.length);
      return subtree(
        asn1.create(asn1.Class.CONTEXT_SPECIFIC, 7, false, bytes + mask),
      );
    }),
  ];
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, subtrees),
  ]);
}

function altNames(hosts: LocalTlsHosts) {
  return [
    ...hosts.dnsNames.map((value) => ({ type: 2, value })),
    ...hosts.ipAddresses.map((ip) => ({ type: 7, ip })),
  ];
}

function sameAltNames(
  certificate: forge.pki.Certificate,
  hosts: LocalTlsHosts,
): boolean {
  const extension = certificate.getExtension("subjectAltName") as
    | { altNames?: Array<{ type: number; value: string }> }
    | undefined;
  const actual = (extension?.altNames ?? [])
    .map((name) =>
      name.type === 2
        ? `dns:${name.value.toLowerCase()}`
        : `ip:${forge.util.bytesToHex(name.value)}`,
    )
    .sort();
  const expected = [
    ...hosts.dnsNames.map((name) => `dns:${name}`),
    ...hosts.ipAddresses.map(
      (address) => `ip:${forge.util.bytesToHex(ipBytes(address))}`,
    ),
  ].sort();
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function ipBytes(address: string): string {
  const bytes = (
    forge.util as unknown as { bytesFromIP(ip: string): string | null }
  ).bytesFromIP(address);
  if (!bytes) throw new Error(`Invalid IP address: ${address}`);
  return bytes;
}

function keyMatches(
  privateKey: forge.pki.rsa.PrivateKey,
  certificate: forge.pki.Certificate,
): boolean {
  const publicKey = certificate.publicKey as forge.pki.rsa.PublicKey;
  return privateKey.n.equals(publicKey.n) && privateKey.e.equals(publicKey.e);
}

function fingerprint(certificatePem: string): string {
  return new X509Certificate(certificatePem).fingerprint256;
}

function describeHosts(hosts: LocalTlsHosts): string {
  return [...hosts.dnsNames, ...hosts.ipAddresses].join(", ");
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
