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

/**
 * Send headers and the first half of a JSON body, then wait for `finish()`
 * before sending the rest: simulates a slow or deliberately stalled client.
 * `response` rejects if the server drops the connection instead.
 */
export function openStalledJsonRequest(input: {
  readonly port: number;
  readonly ca: string;
  readonly method?: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body: unknown;
}): { readonly response: Promise<TestResponse>; finish(): void } {
  const payload = Buffer.from(JSON.stringify(input.body), "utf8");
  const half = Math.floor(payload.length / 2);
  let request!: http.ClientRequest;
  const response = new Promise<TestResponse>((resolve, reject) => {
    request = https.request(
      {
        host: "127.0.0.1",
        port: input.port,
        servername: "localhost",
        ca: input.ca,
        method: input.method ?? "POST",
        path: input.path,
        agent: false,
        headers: {
          host: `localhost:${input.port}`,
          "content-type": "application/json",
          "content-length": String(payload.length),
          ...input.headers,
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("error", reject);
        incoming.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: text ? (JSON.parse(text) as unknown) : undefined,
          });
        });
      },
    );
    request.on("error", reject);
    request.write(payload.subarray(0, half));
  });
  // Callers may assert on a dropped connection later; do not report it as
  // an unhandled rejection in the meantime.
  response.catch(() => undefined);
  return {
    response,
    finish() {
      if (!request.destroyed) request.end(payload.subarray(half));
    },
  };
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

export interface TestServerSentEvent {
  readonly id?: string;
  readonly event: string;
  readonly data: unknown;
}

export interface TestEventStream {
  readonly status: number;
  readonly events: TestServerSentEvent[];
  /** Resolves when the server ends the stream. */
  readonly ended: Promise<void>;
  waitFor(
    predicate: (event: TestServerSentEvent) => boolean,
    timeoutMs?: number,
  ): Promise<TestServerSentEvent>;
  close(): void;
  /** Start reading a stream opened with `paused`. */
  resume(): void;
}

/** Minimal SSE client over HTTPS for tests. */
export function openEventStream(input: {
  readonly port: number;
  readonly ca: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  /** Never read the body: simulates a client that stops draining. */
  readonly paused?: boolean;
}): Promise<TestEventStream> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port: input.port,
        servername: "localhost",
        ca: input.ca,
        path: input.path,
        agent: false,
        headers: {
          host: `localhost:${input.port}`,
          accept: "text/event-stream",
          ...input.headers,
        },
      },
      (response) => {
        const events: TestServerSentEvent[] = [];
        const waiters = new Set<() => void>();
        let buffered = "";
        let resolveEnded!: () => void;
        const ended = new Promise<void>((done) => {
          resolveEnded = done;
        });
        response.setEncoding("utf8");
        if (input.paused) response.pause();
        response.on("data", (chunk: string) => {
          buffered += chunk;
          let boundary = buffered.indexOf("\n\n");
          while (boundary >= 0) {
            const block = buffered.slice(0, boundary);
            buffered = buffered.slice(boundary + 2);
            boundary = buffered.indexOf("\n\n");
            let id: string | undefined;
            let name = "message";
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith(":")) continue;
              const separator = line.indexOf(":");
              const field = separator < 0 ? line : line.slice(0, separator);
              const value =
                separator < 0 ? "" : line.slice(separator + 1).trimStart();
              if (field === "id") id = value;
              else if (field === "event") name = value;
              else if (field === "data") data.push(value);
            }
            if (data.length === 0) continue;
            const text = data.join("\n");
            let parsed: unknown = text;
            try {
              parsed = JSON.parse(text);
            } catch {
              // Keep raw text.
            }
            events.push({ ...(id ? { id } : {}), event: name, data: parsed });
            for (const waiter of Array.from(waiters)) waiter();
          }
        });
        const finish = () => {
          resolveEnded();
          for (const waiter of Array.from(waiters)) waiter();
        };
        response.on("end", finish);
        response.on("close", finish);
        response.on("error", finish);
        // A paused response may not emit `close`; the request always does.
        request.on("close", finish);
        resolve({
          status: response.statusCode ?? 0,
          events,
          ended,
          waitFor(predicate, timeoutMs = 5_000) {
            return new Promise((done, fail) => {
              const check = () => {
                const found = events.find(predicate);
                if (found) {
                  cleanup();
                  done(found);
                }
              };
              const timer = setTimeout(() => {
                cleanup();
                fail(
                  new Error(
                    `Timed out waiting for event; saw ${JSON.stringify(events)}`,
                  ),
                );
              }, timeoutMs);
              const cleanup = () => {
                clearTimeout(timer);
                waiters.delete(check);
              };
              waiters.add(check);
              check();
            });
          },
          close() {
            request.destroy();
          },
          resume() {
            response.resume();
          },
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

export function sessionCookieFrom(response: TestResponse): string {
  const header = response.headers["set-cookie"]?.[0];
  if (!header) throw new Error("missing set-cookie");
  return header.split(";")[0]!;
}
