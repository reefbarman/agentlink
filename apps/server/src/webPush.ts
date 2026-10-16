import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";

/**
 * Web Push primitives on `node:crypto`, with no third-party dependency:
 *
 * - VAPID keys and the `Authorization: vapid` header (RFC 8292), signed
 *   ES256 with a P-256 key the server keeps.
 * - Message encryption for one subscription (RFC 8291, `aes128gcm` from
 *   RFC 8188): a fresh ECDH key and salt per message, a single record.
 */

/** Uncompressed P-256 public key length: `0x04 || x || y`. */
const PUBLIC_KEY_LENGTH = 65;
const PRIVATE_KEY_LENGTH = 32;
const AUTH_SECRET_LENGTH = 16;
const SALT_LENGTH = 16;
const RECORD_SIZE = 4096;
/** Push services accept bodies up to 4096 bytes. */
export const MAX_PUSH_BODY_BYTES = 4096;
/** Header (86) + padding delimiter (1) + GCM tag (16). */
const ENCRYPTION_OVERHEAD = SALT_LENGTH + 4 + 1 + PUBLIC_KEY_LENGTH + 1 + 16;
export const MAX_PUSH_PLAINTEXT_BYTES =
  MAX_PUSH_BODY_BYTES - ENCRYPTION_OVERHEAD;
/** RFC 8292: tokens must expire within 24 hours. */
const MAX_VAPID_TOKEN_SECONDS = 24 * 60 * 60;
const DEFAULT_VAPID_TOKEN_SECONDS = 12 * 60 * 60;

export interface VapidKeys {
  /** Base64url uncompressed public key: the `applicationServerKey`. */
  readonly publicKey: string;
  /** Base64url 32-byte private scalar. */
  readonly privateKey: string;
}

export class WebPushError extends Error {}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: fixedLength(ecdh.getPrivateKey()).toString("base64url"),
  };
}

/** Throws unless the private key is valid and matches the public key. */
export function checkVapidKeys(keys: VapidKeys): void {
  const publicKey = decodeBase64Url(keys.publicKey);
  const privateKey = decodeBase64Url(keys.privateKey);
  if (
    publicKey.length !== PUBLIC_KEY_LENGTH ||
    privateKey.length !== PRIVATE_KEY_LENGTH
  ) {
    throw new WebPushError("The VAPID keys have the wrong length");
  }
  const ecdh = createECDH("prime256v1");
  try {
    ecdh.setPrivateKey(privateKey);
  } catch {
    throw new WebPushError("The VAPID private key is invalid");
  }
  if (!ecdh.getPublicKey().equals(publicKey)) {
    throw new WebPushError("The VAPID keys do not belong together");
  }
}

function vapidSigningKey(keys: VapidKeys): KeyObject {
  const publicKey = decodeBase64Url(keys.publicKey);
  return createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: publicKey.subarray(1, 33).toString("base64url"),
      y: publicKey.subarray(33, 65).toString("base64url"),
    },
  });
}

/**
 * The `Authorization` header for one push request (RFC 8292): an ES256
 * JWT for the push service's origin, and the public key.
 */
export function vapidAuthorization(options: {
  readonly endpoint: string;
  readonly keys: VapidKeys;
  /** `mailto:` or `https:` contact the push service can use. */
  readonly subject: string;
  readonly now: number;
  readonly expiresInSeconds?: number;
}): string {
  const seconds = Math.min(
    options.expiresInSeconds ?? DEFAULT_VAPID_TOKEN_SECONDS,
    MAX_VAPID_TOKEN_SECONDS,
  );
  const header = base64UrlJson({ typ: "JWT", alg: "ES256" });
  const claims = base64UrlJson({
    aud: new URL(options.endpoint).origin,
    exp: Math.floor(options.now / 1000) + seconds,
    sub: options.subject,
  });
  const signingInput = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: vapidSigningKey(options.keys),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `vapid t=${signingInput}.${signature}, k=${options.keys.publicKey}`;
}

/** Throws unless these are a usable subscription's `p256dh` and `auth`. */
export function checkSubscriptionKeys(keys: {
  readonly p256dh: string;
  readonly auth: string;
}): void {
  const publicKey = decodeBase64Url(keys.p256dh);
  const authSecret = decodeBase64Url(keys.auth);
  if (publicKey.length !== PUBLIC_KEY_LENGTH || publicKey[0] !== 0x04) {
    throw new WebPushError("The subscription's p256dh key is invalid");
  }
  if (authSecret.length !== AUTH_SECRET_LENGTH) {
    throw new WebPushError("The subscription's auth secret is invalid");
  }
  // Rejects points that are not on the curve (RFC 8291 section 7).
  const probe = createECDH("prime256v1");
  probe.generateKeys();
  try {
    probe.computeSecret(publicKey);
  } catch {
    throw new WebPushError("The subscription's p256dh key is not on P-256");
  }
}

/**
 * Encrypt a message for one subscription (RFC 8291). `asPrivateKey` and
 * `salt` are only for test vectors; normally both are fresh per message.
 */
export function encryptPushMessage(options: {
  /** The subscription's `p256dh`, base64url. */
  readonly p256dh: string;
  /** The subscription's `auth`, base64url. */
  readonly auth: string;
  readonly plaintext: Buffer;
  readonly asPrivateKey?: Buffer;
  readonly salt?: Buffer;
}): Buffer {
  checkSubscriptionKeys(options);
  if (options.plaintext.length > MAX_PUSH_PLAINTEXT_BYTES) {
    throw new WebPushError(
      `A push message can be at most ${MAX_PUSH_PLAINTEXT_BYTES} bytes`,
    );
  }
  const uaPublic = decodeBase64Url(options.p256dh);
  const authSecret = decodeBase64Url(options.auth);
  const ecdh = createECDH("prime256v1");
  if (options.asPrivateKey) ecdh.setPrivateKey(options.asPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    uaPublic,
    asPublic,
  ]);
  const ikm = Buffer.from(
    hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32),
  );
  const salt = options.salt ?? randomBytes(SALT_LENGTH);
  if (salt.length !== SALT_LENGTH) {
    throw new WebPushError("The salt must be 16 bytes");
  }
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12),
  );
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // One record, so the last-record delimiter and no padding.
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([options.plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([
    salt,
    recordSize,
    Buffer.from([asPublic.length]),
    asPublic,
    ciphertext,
  ]);
}

export function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*={0,2}$/u.test(value)) {
    throw new WebPushError("Expected a base64url value");
  }
  return Buffer.from(value, "base64url");
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** ECDH private scalars can come back shorter than 32 bytes. */
function fixedLength(scalar: Buffer): Buffer {
  if (scalar.length === PRIVATE_KEY_LENGTH) return scalar;
  const padded = Buffer.alloc(PRIVATE_KEY_LENGTH);
  scalar.copy(padded, PRIVATE_KEY_LENGTH - scalar.length);
  return padded;
}
