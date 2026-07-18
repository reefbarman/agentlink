import { createConnection, createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer, get as httpGet } from "node:http";

import assert from "node:assert/strict";
import { startTrustedNetworkProxies } from "./sandbox-network-proxy.mjs";
import test from "node:test";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function proxyAuthorization(credentials) {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
}

function httpViaProxy(proxyPort, url, credentials) {
  return new Promise((resolve, reject) => {
    const headers = { host: new URL(url).host };
    if (credentials) {
      headers["proxy-authorization"] = proxyAuthorization(credentials);
    }
    const request = httpGet(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path: url,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            statusCode: response.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
  });
}

function connectViaProxy(proxyPort, authority, payload, credentials) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(proxyPort, "127.0.0.1");
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("CONNECT test client timed out"));
    }, 2_000);
    const finish = (value) => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(value);
    };
    let buffer = Buffer.alloc(0);
    socket.once("connect", () => {
      const authorization = credentials
        ? `Proxy-Authorization: ${proxyAuthorization(credentials)}\r\n`
        : "";
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization}\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const status = buffer.subarray(0, headerEnd).toString("latin1");
      if (!status.startsWith("HTTP/1.1 200")) {
        finish({ status, body: "" });
        return;
      }
      socket.removeAllListeners("data");
      socket.once("data", (data) => {
        finish({ status, body: data.toString("utf8") });
      });
      socket.write(payload);
    });
    socket.once("error", reject);
  });
}

function socksViaProxy(proxyPort, host, port, payload, credentials) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(proxyPort, "127.0.0.1");
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("SOCKS test client timed out"));
    }, 2_000);
    const finish = (value) => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () =>
      socket.write(Buffer.from(credentials ? [5, 1, 2] : [5, 1, 0])),
    );
    socket.once("data", (greeting) => {
      if (!credentials || greeting[1] !== 2) {
        finish({ method: greeting[1], authStatus: undefined, body: "" });
        return;
      }
      const username = Buffer.from(credentials.username);
      const password = Buffer.from(credentials.password);
      socket.write(
        Buffer.concat([
          Buffer.from([1, username.length]),
          username,
          Buffer.from([password.length]),
          password,
        ]),
      );
      socket.once("data", (authentication) => {
        if (authentication[1] !== 0) {
          finish({
            method: greeting[1],
            authStatus: authentication[1],
            body: "",
          });
          return;
        }
        const encodedHost = Buffer.from(host);
        const request = Buffer.alloc(7 + encodedHost.length);
        request.set([5, 1, 0, 3, encodedHost.length], 0);
        encodedHost.copy(request, 5);
        request.writeUInt16BE(port, 5 + encodedHost.length);
        socket.write(request);
        socket.once("data", (reply) => {
          if (reply[1] !== 0) {
            finish({
              method: greeting[1],
              authStatus: authentication[1],
              reply: reply[1],
              body: "",
            });
            return;
          }
          socket.write(payload);
          socket.once("data", (data) => {
            finish({
              method: greeting[1],
              authStatus: authentication[1],
              reply: reply[1],
              body: data.toString("utf8"),
            });
          });
        });
      });
    });
    socket.once("error", reject);
  });
}

async function withEchoFixture(operation) {
  const echoFixture = createTcpServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echoFixture);
  try {
    await operation({ echoPort });
  } finally {
    await close(echoFixture);
  }
}

test("HTTP, CONNECT, and SOCKS deny mixed public/private DNS answers", async () => {
  const proxies = await startTrustedNetworkProxies(
    ["mixed.example"],
    {
      lookupAll: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    },
    {
      dial: async () => {
        throw new Error("policy denial must happen before dialing");
      },
    },
  );
  try {
    const http = await httpViaProxy(
      proxies.httpPort,
      "http://mixed.example:8080/private",
      proxies.credentials,
    );
    assert.equal(http.statusCode, 403);

    const connect = await connectViaProxy(
      proxies.httpPort,
      "mixed.example:443",
      "connect",
      proxies.credentials,
    );
    assert.match(connect.status, /403 Forbidden/);

    const socks = await socksViaProxy(
      proxies.socksPort,
      "mixed.example",
      443,
      "socks",
      proxies.credentials,
    );
    assert.equal(socks.authStatus, 0);
    assert.equal(socks.reply, 2);
  } finally {
    await proxies.close();
  }
});

test("CONNECT and SOCKS dial only the validated numeric address", async () => {
  await withEchoFixture(async ({ echoPort }) => {
    const dials = [];
    const proxies = await startTrustedNetworkProxies(
      ["allowed.example"],
      {
        lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      {
        dial: async (approved, port) => {
          dials.push({ approved, port });
          return createConnection(port, "127.0.0.1");
        },
      },
    );
    try {
      const connect = await connectViaProxy(
        proxies.httpPort,
        `allowed.example:${echoPort}`,
        "connect-ok",
        proxies.credentials,
      );
      assert.match(connect.status, /200 Connection Established/);
      assert.equal(connect.body, "connect-ok");

      const socks = await socksViaProxy(
        proxies.socksPort,
        "allowed.example",
        echoPort,
        "socks-ok",
        proxies.credentials,
      );
      assert.equal(socks.authStatus, 0);
      assert.equal(socks.reply, 0);
      assert.equal(socks.body, "socks-ok");

      assert.equal(dials.length, 2);
      for (const dial of dials) {
        assert.equal(dial.approved.address, "93.184.216.34");
        assert.equal(dial.approved.family, 4);
        assert.equal(dial.approved.requestedHost, "allowed.example");
      }
    } finally {
      await proxies.close();
    }
  });
});

test("proxy authentication rejects missing, wrong, and cross-session credentials before policy evaluation", async () => {
  let policyEvaluations = 0;
  let dials = 0;
  const options = {
    lookupAll: async () => {
      policyEvaluations += 1;
      return [{ address: "93.184.216.34", family: 4 }];
    },
  };
  const adapter = {
    dial: async () => {
      dials += 1;
      throw new Error("authentication denial must happen before dialing");
    },
  };
  const first = await startTrustedNetworkProxies(
    ["allowed.example"],
    options,
    adapter,
  );
  const second = await startTrustedNetworkProxies(
    ["allowed.example"],
    options,
    adapter,
  );
  const wrong = { ...first.credentials, password: "0".repeat(64) };
  let firstClosed = false;
  try {
    const missingHttp = await httpViaProxy(
      first.httpPort,
      "http://allowed.example/resource",
    );
    assert.equal(missingHttp.statusCode, 407);
    const wrongConnect = await connectViaProxy(
      first.httpPort,
      "allowed.example:443",
      "denied",
      wrong,
    );
    assert.match(wrongConnect.status, /407 Proxy Authentication Required/);
    const missingSocks = await socksViaProxy(
      first.socksPort,
      "allowed.example",
      443,
      "denied",
    );
    assert.equal(missingSocks.method, 0xff);
    const wrongSocks = await socksViaProxy(
      first.socksPort,
      "allowed.example",
      443,
      "denied",
      wrong,
    );
    assert.equal(wrongSocks.method, 2);
    assert.equal(wrongSocks.authStatus, 1);
    const crossSessionHttp = await httpViaProxy(
      first.httpPort,
      "http://allowed.example/resource",
      second.credentials,
    );
    assert.equal(crossSessionHttp.statusCode, 407);
    const crossSessionSocks = await socksViaProxy(
      first.socksPort,
      "allowed.example",
      443,
      "denied",
      second.credentials,
    );
    assert.equal(crossSessionSocks.authStatus, 1);
    assert.equal(policyEvaluations, 0);
    assert.equal(dials, 0);
    assert.notEqual(first.credentials.password, second.credentials.password);
    await first.close();
    firstClosed = true;
    await assert.rejects(
      httpViaProxy(
        first.httpPort,
        "http://allowed.example/resource",
        first.credentials,
      ),
    );
  } finally {
    await Promise.all([
      ...(firstClosed ? [] : [first.close()]),
      second.close(),
    ]);
  }
});
