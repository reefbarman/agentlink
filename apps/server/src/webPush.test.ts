import {
  MAX_PUSH_PLAINTEXT_BYTES,
  checkSubscriptionKeys,
  checkVapidKeys,
  encryptPushMessage,
  generateVapidKeys,
  vapidAuthorization,
} from "./webPush.js";
import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decryptPushMessage } from "./testSupport.js";

/** RFC 8291 Appendix A (whitespace removed). */
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  header:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext:
    "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

const b64 = (value: string) => Buffer.from(value, "base64url");

describe("encryptPushMessage", () => {
  it("matches the RFC 8291 example", () => {
    const body = encryptPushMessage({
      p256dh: RFC.uaPublic,
      auth: RFC.auth,
      plaintext: b64(RFC.plaintext),
      asPrivateKey: b64(RFC.asPrivate),
      salt: b64(RFC.salt),
    });
    expect(body.subarray(0, 86).toString("base64url")).toBe(RFC.header);
    expect(body.subarray(86).toString("base64url")).toBe(RFC.ciphertext);
  });

  it("uses a fresh key and salt per message that the browser can read", () => {
    const plaintext = Buffer.from(JSON.stringify({ title: "Done" }));
    const first = encryptPushMessage({
      p256dh: RFC.uaPublic,
      auth: RFC.auth,
      plaintext,
    });
    const second = encryptPushMessage({
      p256dh: RFC.uaPublic,
      auth: RFC.auth,
      plaintext,
    });
    expect(first.subarray(0, 16)).not.toEqual(second.subarray(0, 16));
    expect(first.subarray(21, 86)).not.toEqual(second.subarray(21, 86));
    expect(
      decryptPushMessage(first, b64(RFC.uaPrivate), b64(RFC.auth)),
    ).toEqual(plaintext);
  });

  it("refuses messages over the push size limit", () => {
    const fits = Buffer.alloc(MAX_PUSH_PLAINTEXT_BYTES, 0x61);
    expect(
      encryptPushMessage({
        p256dh: RFC.uaPublic,
        auth: RFC.auth,
        plaintext: fits,
      }).length,
    ).toBe(4096);
    expect(() =>
      encryptPushMessage({
        p256dh: RFC.uaPublic,
        auth: RFC.auth,
        plaintext: Buffer.alloc(MAX_PUSH_PLAINTEXT_BYTES + 1),
      }),
    ).toThrow(/at most/u);
  });
});

describe("checkSubscriptionKeys", () => {
  it("accepts a browser's keys and refuses malformed ones", () => {
    expect(() =>
      checkSubscriptionKeys({ p256dh: RFC.uaPublic, auth: RFC.auth }),
    ).not.toThrow();
    expect(() =>
      checkSubscriptionKeys({ p256dh: RFC.uaPublic, auth: "c2hvcnQ" }),
    ).toThrow(/auth/u);
    expect(() =>
      checkSubscriptionKeys({ p256dh: RFC.auth, auth: RFC.auth }),
    ).toThrow(/p256dh/u);
    // Right length and prefix, but not a point on the curve.
    const offCurve = Buffer.alloc(65, 1);
    offCurve[0] = 0x04;
    expect(() =>
      checkSubscriptionKeys({
        p256dh: offCurve.toString("base64url"),
        auth: RFC.auth,
      }),
    ).toThrow(/P-256/u);
    expect(() =>
      checkSubscriptionKeys({ p256dh: "not base64!", auth: RFC.auth }),
    ).toThrow(/base64url/u);
  });
});

describe("VAPID", () => {
  it("generates matching keys and refuses mismatched ones", () => {
    const keys = generateVapidKeys();
    expect(Buffer.from(keys.publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(keys.privateKey, "base64url")).toHaveLength(32);
    expect(() => checkVapidKeys(keys)).not.toThrow();
    const other = generateVapidKeys();
    expect(() =>
      checkVapidKeys({
        publicKey: keys.publicKey,
        privateKey: other.privateKey,
      }),
    ).toThrow(/belong together/u);
  });

  it("signs an ES256 token for the push service's origin", () => {
    const keys = generateVapidKeys();
    const now = Date.parse("2026-10-10T00:00:00Z");
    const header = vapidAuthorization({
      endpoint: "https://web.push.apple.com/QGuQyavXut/abc?x=1",
      keys,
      subject: "mailto:owner@example.com",
      now,
    });
    const match = /^vapid t=([^,]+), k=(.+)$/u.exec(header);
    expect(match?.[2]).toBe(keys.publicKey);
    const [encodedHeader, encodedClaims, signature] = match![1]!.split(".");
    expect(JSON.parse(b64(encodedHeader!).toString())).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    expect(JSON.parse(b64(encodedClaims!).toString())).toEqual({
      aud: "https://web.push.apple.com",
      exp: now / 1000 + 12 * 60 * 60,
      sub: "mailto:owner@example.com",
    });
    const publicKey = b64(keys.publicKey);
    const verifier = createPublicKey({
      format: "jwk",
      key: {
        kty: "EC",
        crv: "P-256",
        x: publicKey.subarray(1, 33).toString("base64url"),
        y: publicKey.subarray(33).toString("base64url"),
      },
    });
    expect(b64(signature!)).toHaveLength(64);
    expect(
      verify(
        "sha256",
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        { key: verifier, dsaEncoding: "ieee-p1363" },
        b64(signature!),
      ),
    ).toBe(true);
  });

  it("never issues a token valid for more than 24 hours", () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization({
      endpoint: "https://fcm.googleapis.com/fcm/send/x",
      keys,
      subject: "https://example.com",
      now: 0,
      expiresInSeconds: 7 * 24 * 60 * 60,
    });
    const claims = header.split(" ")[1]!.slice(2).split(".")[1]!;
    expect(JSON.parse(b64(claims).toString()).exp).toBe(24 * 60 * 60);
  });
});
