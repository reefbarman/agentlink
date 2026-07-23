import {
  NetworkPolicyError,
  resolveApprovedDestination,
} from "./sandbox-network-policy.mjs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import {
  createServer as createTcpServer,
  connect as netConnect,
} from "node:net";

import { request as httpsRequest } from "node:https";

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_SOCKS_HANDSHAKE_BYTES = 1024;
const PROXY_AUTH_USERNAME = "agentlink";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function credentialDigest(username, password) {
  return createHash("sha256")
    .update(username)
    .update("\0")
    .update(password)
    .digest();
}

function credentialsMatch(expected, username, password) {
  const actualDigest = credentialDigest(username, password);
  return timingSafeEqual(expected.digest, actualDigest);
}

function parseBasicProxyAuthorization(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})\s*$/.exec(value);
  if (!match) {
    return undefined;
  }
  let decoded;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf(":");
  if (separator <= 0) {
    return undefined;
  }
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

function isHttpAuthenticated(request, credentials) {
  const supplied = parseBasicProxyAuthorization(
    request.headers["proxy-authorization"],
  );
  return (
    supplied !== undefined &&
    credentialsMatch(credentials, supplied.username, supplied.password)
  );
}

function rejectHttpAuthentication(target) {
  target.writeHead?.(407, {
    "Proxy-Authenticate": 'Basic realm="AgentLink sandbox session"',
    Connection: "close",
    "Content-Type": "text/plain",
  });
  if (typeof target.writeHead === "function") {
    target.end("Proxy authentication required");
  } else {
    target.end(
      'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="AgentLink sandbox session"\r\nConnection: close\r\n\r\n',
    );
  }
}

function stripHopByHopHeaders(headers) {
  const extra = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !HOP_BY_HOP_HEADERS.has(name.toLowerCase()) &&
        !extra.has(name.toLowerCase()),
    ),
  );
}

function parseConnectTarget(target) {
  const match =
    /^\[([^\]]+)\]:(\d+)$/.exec(target ?? "") ??
    /^([^:]+):(\d+)$/.exec(target ?? "");
  if (!match) {
    return undefined;
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return { host: match[1], port };
}

function authorizationAbortError(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("destination authorization aborted");
}

function waitForAuthorization(authorizeDestination, request, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(authorizationAbortError(signal));
      return;
    }
    let settled = false;
    const finish = (operation, value) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation(value);
    };
    const onAbort = () => finish(reject, authorizationAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => authorizeDestination(request, signal))
      .then(
        (decision) => finish(resolve, decision),
        (error) => finish(reject, error),
      );
  });
}

function createDestinationAuthorizer(authorizeDestination, signal) {
  if (!authorizeDestination) {
    return async () => {};
  }
  return async (approved, protocol, port) => {
    const answers = Object.freeze(
      (approved.answers ?? []).map((answer) => Object.freeze({ ...answer })),
    );
    const request = Object.freeze({
      host: approved.requestedHost,
      protocol,
      port,
      address: approved.address,
      family: approved.family,
      answers,
    });
    const decision = await waitForAuthorization(
      authorizeDestination,
      request,
      signal,
    );
    if (decision === "reject") {
      throw new NetworkPolicyError(
        "destination authorization rejected request",
      );
    }
    if (decision !== "allow") {
      throw new NetworkPolicyError(
        "destination authorization returned an invalid decision",
      );
    }
  };
}

function isPolicyDenied(error) {
  return error instanceof NetworkPolicyError;
}

function dialApproved(approved, port) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({
      host: approved.address,
      port,
      family: approved.family,
    });
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.setTimeout(0);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onConnect = () => finish();
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("socket closed before connect"));
    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      finish(new Error("connect timed out")),
    );
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function pipeSockets(client, upstream, head = Buffer.alloc(0)) {
  if (head.length > 0) {
    upstream.write(head);
  }
  upstream.pipe(client);
  client.pipe(upstream);
  client.once("close", () => upstream.destroy());
  upstream.once("close", () => client.destroy());
  client.once("error", () => upstream.destroy());
  upstream.once("error", () => client.destroy());
}

function trackServerSockets(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

function listenLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("proxy did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server, sockets) {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createHttpProxy(
  allowedDomains,
  credentials,
  resolverOptions,
  authorize,
  dial,
  requestHttp,
  requestHttps,
) {
  const server = createHttpServer();
  server.on("connect", async (request, client, head) => {
    if (!isHttpAuthenticated(request, credentials)) {
      rejectHttpAuthentication(client);
      return;
    }
    const target = parseConnectTarget(request.url);
    if (!target) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    try {
      const approved = await resolveApprovedDestination(
        target.host,
        allowedDomains,
        resolverOptions,
      );
      await authorize(approved, "connect:", target.port);
      if (client.destroyed) {
        return;
      }
      const upstream = await dial(approved, target.port);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      pipeSockets(client, upstream, head);
    } catch (error) {
      const policyDenied = isPolicyDenied(error);
      client.end(
        `HTTP/1.1 ${policyDenied ? "403 Forbidden" : "502 Bad Gateway"}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${policyDenied ? "Connection blocked by AgentLink network policy" : "Upstream connection failed"}`,
      );
    }
  });
  server.on("request", async (request, response) => {
    if (!isHttpAuthenticated(request, credentials)) {
      rejectHttpAuthentication(response);
      return;
    }
    let url;
    try {
      url = new URL(request.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("unsupported proxy URL scheme");
      }
      const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
      const approved = await resolveApprovedDestination(
        url.hostname,
        allowedDomains,
        resolverOptions,
      );
      await authorize(approved, url.protocol, port);
      if (request.socket.destroyed) {
        return;
      }
      const headers = {
        ...stripHopByHopHeaders(request.headers),
        host: url.host,
      };
      const upstreamRequest = (
        url.protocol === "https:" ? requestHttps : requestHttp
      )(
        {
          host: approved.address,
          family: approved.family,
          port,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers,
          ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            stripHopByHopHeaders(upstreamResponse.headers),
          );
          upstreamResponse.pipe(response);
        },
      );
      upstreamRequest.once("error", () => {
        if (!response.headersSent) {
          response.writeHead(502, { "Content-Type": "text/plain" });
        }
        response.end("Upstream connection failed");
      });
      response.once("close", () => upstreamRequest.destroy());
      request.pipe(upstreamRequest);
    } catch (error) {
      const policyDenied = isPolicyDenied(error);
      response.writeHead(policyDenied ? 403 : 400, {
        "Content-Type": "text/plain",
        Connection: "close",
      });
      response.end(
        policyDenied
          ? "Connection blocked by AgentLink network policy"
          : "Invalid proxy request",
      );
    }
  });
  return server;
}

function parseSocksRequest(buffer) {
  if (buffer.length < 4) {
    return undefined;
  }
  if (buffer[0] !== 5) {
    throw new Error("invalid SOCKS5 request");
  }
  if (buffer[1] !== 1 || buffer[2] !== 0) {
    throw new Error("unsupported SOCKS5 command");
  }
  const addressType = buffer[3];
  let offset = 4;
  let host;
  if (addressType === 1) {
    if (buffer.length < offset + 4 + 2) {
      return undefined;
    }
    host = [...buffer.subarray(offset, offset + 4)].join(".");
    offset += 4;
  } else if (addressType === 3) {
    if (buffer.length < offset + 1) {
      return undefined;
    }
    const length = buffer[offset];
    offset += 1;
    if (buffer.length < offset + length + 2) {
      return undefined;
    }
    host = buffer.subarray(offset, offset + length).toString("utf8");
    offset += length;
  } else if (addressType === 4) {
    if (buffer.length < offset + 16 + 2) {
      return undefined;
    }
    const groups = [];
    for (let index = 0; index < 16; index += 2) {
      groups.push(buffer.readUInt16BE(offset + index).toString(16));
    }
    host = groups.join(":");
    offset += 16;
  } else {
    throw new Error("unsupported SOCKS5 address type");
  }
  const port = buffer.readUInt16BE(offset);
  if (port < 1) {
    throw new Error("invalid SOCKS5 port");
  }
  return { host, port, consumed: offset + 2 };
}

function createSocksProxy(
  allowedDomains,
  credentials,
  resolverOptions,
  authorize,
  dial,
) {
  return createTcpServer((client) => {
    let buffer = Buffer.alloc(0);
    let phase = "greeting";
    const fail = (reply = 1) => {
      if (!client.destroyed) {
        client.end(Buffer.from([5, reply, 0, 1, 0, 0, 0, 0, 0, 0]));
      }
    };
    const onData = async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_SOCKS_HANDSHAKE_BYTES) {
        client.destroy();
        return;
      }
      try {
        if (phase === "greeting") {
          if (buffer.length < 2) {
            return;
          }
          if (buffer[0] !== 5) {
            client.destroy();
            return;
          }
          const methodCount = buffer[1];
          if (buffer.length < methodCount + 2) {
            return;
          }
          const methods = buffer.subarray(2, methodCount + 2);
          buffer = buffer.subarray(methodCount + 2);
          if (!methods.includes(2)) {
            client.end(Buffer.from([5, 0xff]));
            return;
          }
          client.write(Buffer.from([5, 2]));
          phase = "authentication";
        }
        if (phase === "authentication") {
          if (buffer.length < 2) {
            return;
          }
          if (buffer[0] !== 1) {
            client.end(Buffer.from([1, 1]));
            return;
          }
          const usernameLength = buffer[1];
          if (buffer.length < 2 + usernameLength + 1) {
            return;
          }
          const passwordLength = buffer[2 + usernameLength];
          const credentialLength = 3 + usernameLength + passwordLength;
          if (buffer.length < credentialLength) {
            return;
          }
          const username = buffer
            .subarray(2, 2 + usernameLength)
            .toString("utf8");
          const password = buffer
            .subarray(3 + usernameLength, credentialLength)
            .toString("utf8");
          buffer = buffer.subarray(credentialLength);
          if (!credentialsMatch(credentials, username, password)) {
            client.end(Buffer.from([1, 1]));
            return;
          }
          client.write(Buffer.from([1, 0]));
          phase = "request";
        }
        if (phase !== "request") {
          return;
        }
        const target = parseSocksRequest(buffer);
        if (!target) {
          return;
        }
        const head = buffer.subarray(target.consumed);
        client.off("data", onData);
        phase = "relay";
        let approved;
        try {
          approved = await resolveApprovedDestination(
            target.host,
            allowedDomains,
            resolverOptions,
          );
          await authorize(approved, "socks5:", target.port);
        } catch {
          fail(2);
          return;
        }
        if (client.destroyed) {
          return;
        }
        try {
          const upstream = await dial(approved, target.port);
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          pipeSockets(client, upstream, head);
        } catch {
          fail(4);
        }
      } catch {
        fail(1);
      }
    };
    client.on("data", onData);
    client.once("error", () => {});
  });
}

export async function startTrustedNetworkProxies(
  allowedDomains,
  resolverOptions = {},
  {
    authorizeDestination,
    dial = dialApproved,
    httpRequest: requestHttp = httpRequest,
    httpsRequest: requestHttps = httpsRequest,
  } = {},
) {
  const sessionId = randomBytes(16).toString("hex");
  const password = randomBytes(32).toString("hex");
  const credentials = {
    username: PROXY_AUTH_USERNAME,
    password,
    digest: credentialDigest(PROXY_AUTH_USERNAME, password),
  };
  const authorizationController = new AbortController();
  const authorize = createDestinationAuthorizer(
    authorizeDestination,
    authorizationController.signal,
  );
  const httpServer = createHttpProxy(
    allowedDomains,
    credentials,
    resolverOptions,
    authorize,
    dial,
    requestHttp,
    requestHttps,
  );
  const socksServer = createSocksProxy(
    allowedDomains,
    credentials,
    resolverOptions,
    authorize,
    dial,
  );
  const httpSockets = trackServerSockets(httpServer);
  const socksSockets = trackServerSockets(socksServer);
  try {
    const httpPort = await listenLoopback(httpServer);
    const socksPort = await listenLoopback(socksServer);
    return {
      sessionId,
      httpPort,
      socksPort,
      credentials: {
        username: credentials.username,
        password: credentials.password,
      },
      async close() {
        authorizationController.abort(
          new Error("trusted network proxies closed during authorization"),
        );
        await Promise.all([
          closeServer(httpServer, httpSockets),
          closeServer(socksServer, socksSockets),
        ]);
      },
    };
  } catch (error) {
    authorizationController.abort(
      new Error("trusted network proxies failed during startup"),
    );
    await Promise.allSettled([
      closeServer(httpServer, httpSockets),
      closeServer(socksServer, socksSockets),
    ]);
    throw error;
  }
}
