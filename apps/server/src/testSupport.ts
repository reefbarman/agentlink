import forge from "node-forge";
import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/** Self-signed `localhost` / `127.0.0.1` certificate for tests only. */
export function createTestCertificate(): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.publicKeyFromPem(publicKey);
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const attributes = [{ name: "commonName", value: "localhost" }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.setExtensions([
    { name: "basicConstraints", cA: false },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: "localhost" },
        { type: 7, ip: "127.0.0.1" },
      ],
    },
  ]);
  certificate.sign(
    forge.pki.privateKeyFromPem(privateKey),
    forge.md.sha256.create(),
  );
  return { cert: forge.pki.certificateToPem(certificate), key: privateKey };
}

export async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address !== "object") throw new Error("no port");
  return address.port;
}

export interface TestResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: unknown;
}

export function httpsRequest(input: {
  readonly port: number;
  readonly ca: string;
  readonly method?: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}): Promise<TestResponse> {
  const payload =
    input.body === undefined ? undefined : JSON.stringify(input.body);
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port: input.port,
        servername: "localhost",
        ca: input.ca,
        method: input.method ?? "GET",
        path: input.path,
        agent: false,
        headers: {
          host: `localhost:${input.port}`,
          ...(payload !== undefined
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              }
            : {}),
          ...input.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : undefined;
          } catch {
            // Keep raw text.
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
          });
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

/** Attempt an upgrade; resolves with 101 or the rejection status. */
export function httpsUpgrade(input: {
  readonly port: number;
  readonly ca: string;
  readonly headers: Record<string, string>;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: "127.0.0.1",
      port: input.port,
      servername: "localhost",
      ca: input.ca,
      path: "/api/events",
      agent: false,
      headers: {
        host: `localhost:${input.port}`,
        connection: "Upgrade",
        upgrade: "websocket",
        ...input.headers,
      },
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
}

export function plainHttpRequest(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: "/api/auth/state", agent: false },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end();
  });
}

export function sessionCookieFrom(response: TestResponse): string {
  const header = response.headers["set-cookie"]?.[0];
  if (!header) throw new Error("missing set-cookie");
  return header.split(";")[0]!;
}
