import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";

/**
 * Trust for the embedded AgentLink Assistant view. The Assistant serves a
 * leaf certificate from its own local CA (`agentlink-server export-ca`).
 * When the owner gives the desktop app that CA, the Assistant view accepts
 * only certificates it issued for the Assistant's host, even if macOS would
 * trust something else, and needs no keychain change.
 */

/** Large enough for any certificate; refuses accidental huge files. */
const MAX_CA_PEM_LENGTH = 64 * 1024;

export interface PinnedAssistantCa {
  readonly pem: string;
  /** Colon-separated SHA-256, as `agentlink-server` prints it. */
  readonly fingerprint256: string;
}

export class AssistantCaError extends Error {
  constructor() {
    super("assistant_ca_invalid");
  }
}

/** Parse a CA certificate PEM, or throw `AssistantCaError`. */
export function parseAssistantCa(pem: unknown): PinnedAssistantCa {
  if (
    typeof pem !== "string" ||
    pem.length > MAX_CA_PEM_LENGTH ||
    !pem.includes("-----BEGIN CERTIFICATE-----")
  ) {
    throw new AssistantCaError();
  }
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(pem);
  } catch {
    throw new AssistantCaError();
  }
  // A leaf pasted by mistake would otherwise never verify anything.
  if (!certificate.ca) throw new AssistantCaError();
  return {
    pem: certificate.toString(),
    fingerprint256: certificate.fingerprint256,
  };
}

/** True when `leafPem` is a current certificate the CA issued for `hostname`. */
export function isTrustedAssistantCertificate(input: {
  readonly leafPem: string;
  readonly ca: PinnedAssistantCa;
  readonly hostname: string;
  readonly now: number;
}): boolean {
  try {
    const leaf = new X509Certificate(input.leafPem);
    const ca = new X509Certificate(input.ca.pem);
    if (!ca.ca || leaf.ca) return false;
    if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) return false;
    for (const certificate of [leaf, ca]) {
      if (
        input.now < Date.parse(certificate.validFrom) ||
        input.now > Date.parse(certificate.validTo)
      ) {
        return false;
      }
    }
    const host = input.hostname.replace(/^\[(.*)\]$/u, "$1");
    return isIP(host)
      ? leaf.checkIP(host) !== undefined
      : leaf.checkHost(host, { subject: "never" }) !== undefined;
  } catch {
    return false;
  }
}
