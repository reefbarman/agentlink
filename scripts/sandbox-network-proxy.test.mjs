import { PassThrough, Readable } from "node:stream";
import { createConnection, createServer as createTcpServer } from "node:net";

import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeHttpRequester(calls) {
  return (options, onResponse) => {
    calls.push(options);
    const request = new PassThrough();
    queueMicrotask(() => {
      const response = Readable.from(["http-ok"]);
      response.statusCode = 200;
      response.headers = { "content-type": "text/plain" };
      onResponse(response);
    });
    return request;
  };
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

test("HTTP, CONNECT, and SOCKS authorize normalized retained destinations before dialing", async () => {
  await withEchoFixture(async ({ echoPort }) => {
    const events = [];
    const authorizations = [];
    const httpDials = [];
    const socketDials = [];
    const answers = [
      { address: "93.184.216.34", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ];
    const proxies = await startTrustedNetworkProxies(
      ["*"],
      {
        lookupAll: async (host) => {
          events.push(`resolve:${host}`);
          return answers;
        },
      },
      {
        authorizeDestination: async (request, signal) => {
          events.push(`authorize:${request.protocol}:${request.host}`);
          assert.equal(signal.aborted, false);
          assert.equal(Object.isFrozen(request), true);
          assert.equal(Object.isFrozen(request.answers), true);
          assert.equal(Object.isFrozen(request.answers[0]), true);
          assert.throws(() => {
            request.address = "127.0.0.1";
          }, TypeError);
          authorizations.push(request);
          return "allow";
        },
        dial: async (approved, port) => {
          events.push(`dial:${approved.requestedHost}`);
          socketDials.push({ approved, port });
          return createConnection(port, "127.0.0.1");
        },
        httpRequest: (options, onResponse) => {
          events.push(`dial:${options.headers.host.split(":")[0]}`);
          return fakeHttpRequester(httpDials)(options, onResponse);
        },
      },
    );
    try {
      const http = await httpViaProxy(
        proxies.httpPort,
        "http://HTTP.Example.:8080/resource",
        proxies.credentials,
      );
      assert.deepEqual(http, { statusCode: 200, body: "http-ok" });

      const connect = await connectViaProxy(
        proxies.httpPort,
        `CONNECT.Example.:${echoPort}`,
        "connect-ok",
        proxies.credentials,
      );
      assert.match(connect.status, /200 Connection Established/);
      assert.equal(connect.body, "connect-ok");

      const socks = await socksViaProxy(
        proxies.socksPort,
        "SOCKS.Example.",
        echoPort,
        "socks-ok",
        proxies.credentials,
      );
      assert.equal(socks.reply, 0);
      assert.equal(socks.body, "socks-ok");

      assert.deepEqual(
        authorizations.map(({ host, protocol, port }) => ({
          host,
          protocol,
          port,
        })),
        [
          { host: "http.example", protocol: "http:", port: 8080 },
          {
            host: "connect.example",
            protocol: "connect:",
            port: echoPort,
          },
          { host: "socks.example", protocol: "socks5:", port: echoPort },
        ],
      );
      for (const authorization of authorizations) {
        assert.equal(authorization.address, answers[0].address);
        assert.equal(authorization.family, answers[0].family);
        assert.deepEqual(authorization.answers, answers);
      }
      assert.equal(httpDials.length, 1);
      assert.equal(httpDials[0].host, answers[0].address);
      assert.equal(httpDials[0].family, answers[0].family);
      assert.equal(socketDials.length, 2);
      for (const { approved } of socketDials) {
        assert.equal(approved.address, answers[0].address);
        assert.equal(approved.family, answers[0].family);
      }
      assert.deepEqual(events, [
        "resolve:http.example",
        "authorize:http::http.example",
        "dial:http.example.",
        "resolve:connect.example",
        "authorize:connect::connect.example",
        "dial:connect.example",
        "resolve:socks.example",
        "authorize:socks5::socks.example",
        "dial:socks.example",
      ]);
    } finally {
      await proxies.close();
    }
  });
});

test("HTTP, CONNECT, and SOCKS authorization rejection never dials", async () => {
  const authorizations = [];
  let dials = 0;
  const proxies = await startTrustedNetworkProxies(
    ["denied.example"],
    {
      lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
    },
    {
      authorizeDestination: async (request) => {
        authorizations.push(request);
        return "reject";
      },
      dial: async () => {
        dials += 1;
        throw new Error("authorization rejection must happen before dialing");
      },
      httpRequest: () => {
        dials += 1;
        throw new Error("authorization rejection must happen before dialing");
      },
    },
  );
  try {
    const http = await httpViaProxy(
      proxies.httpPort,
      "http://denied.example/resource",
      proxies.credentials,
    );
    assert.equal(http.statusCode, 403);

    const connect = await connectViaProxy(
      proxies.httpPort,
      "denied.example:443",
      "denied",
      proxies.credentials,
    );
    assert.match(connect.status, /403 Forbidden/);

    const socks = await socksViaProxy(
      proxies.socksPort,
      "denied.example",
      443,
      "denied",
      proxies.credentials,
    );
    assert.equal(socks.reply, 2);
    assert.equal(dials, 0);
    assert.deepEqual(
      authorizations.map(({ protocol }) => protocol),
      ["http:", "connect:", "socks5:"],
    );
  } finally {
    await proxies.close();
  }
});

test("transport failures containing policy-like words are not classified as policy denials", async () => {
  const proxies = await startTrustedNetworkProxies(["transport.example"], {
    lookupAll: async () => {
      throw new Error("DNS answer transport unavailable for destination host");
    },
  });
  try {
    const http = await httpViaProxy(
      proxies.httpPort,
      "http://transport.example/resource",
      proxies.credentials,
    );
    assert.deepEqual(http, {
      statusCode: 400,
      body: "Invalid proxy request",
    });

    const connect = await connectViaProxy(
      proxies.httpPort,
      "transport.example:443",
      "unused",
      proxies.credentials,
    );
    assert.match(connect.status, /502 Bad Gateway/);
    assert.equal(connect.body, "");
  } finally {
    await proxies.close();
  }
});

test("closing proxies aborts pending authorization and destroys its client socket", async () => {
  const entered = deferred();
  const aborted = deferred();
  let dials = 0;
  const proxies = await startTrustedNetworkProxies(
    ["pending.example"],
    {
      lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
    },
    {
      authorizeDestination: async (_request, signal) => {
        entered.resolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted.resolve(signal.reason);
              reject(signal.reason);
            },
            { once: true },
          );
        });
        return "allow";
      },
      httpRequest: () => {
        dials += 1;
        throw new Error("close must abort before dialing");
      },
    },
  );
  const request = httpViaProxy(
    proxies.httpPort,
    "http://pending.example/resource",
    proxies.credentials,
  );
  await entered.promise;
  await proxies.close();
  const reason = await aborted.promise;
  assert.match(reason.message, /closed during authorization/);
  await assert.rejects(request);
  assert.equal(dials, 0);
});

test("wildcard HTTP, CONNECT, and SOCKS deny mixed public/private DNS answers", async () => {
  const proxies = await startTrustedNetworkProxies(
    ["*"],
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

test("HTTP, CONNECT, and SOCKS reject forbidden target classes before review or dial", async () => {
  const forbiddenAnswers = new Map([
    ["private.denied.example", { address: "10.0.0.1", family: 4 }],
    ["loopback.denied.example", { address: "127.0.0.1", family: 4 }],
    ["link-local.denied.example", { address: "169.254.1.1", family: 4 }],
    ["metadata.denied.example", { address: "169.254.169.254", family: 4 }],
    ["special.denied.example", { address: "224.0.0.1", family: 4 }],
  ]);
  let authorizations = 0;
  let dials = 0;
  const proxies = await startTrustedNetworkProxies(
    ["*"],
    {
      lookupAll: async (host) => {
        const answer = forbiddenAnswers.get(host);
        assert.ok(answer, `unexpected host ${host}`);
        return [answer];
      },
    },
    {
      authorizeDestination: async () => {
        authorizations += 1;
        return "allow";
      },
      dial: async () => {
        dials += 1;
        throw new Error("forbidden target must be rejected before dialing");
      },
      httpRequest: () => {
        dials += 1;
        throw new Error("forbidden target must be rejected before dialing");
      },
    },
  );
  try {
    for (const host of forbiddenAnswers.keys()) {
      const http = await httpViaProxy(
        proxies.httpPort,
        `http://${host}/resource`,
        proxies.credentials,
      );
      assert.equal(http.statusCode, 403, `HTTP ${host}`);

      const connect = await connectViaProxy(
        proxies.httpPort,
        `${host}:443`,
        "denied",
        proxies.credentials,
      );
      assert.match(connect.status, /403 Forbidden/, `CONNECT ${host}`);

      const socks = await socksViaProxy(
        proxies.socksPort,
        host,
        443,
        "denied",
        proxies.credentials,
      );
      assert.equal(socks.reply, 2, `SOCKS ${host}`);
    }
    assert.equal(authorizations, 0);
    assert.equal(dials, 0);
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
  let authorizations = 0;
  let dials = 0;
  const options = {
    lookupAll: async () => {
      policyEvaluations += 1;
      return [{ address: "93.184.216.34", family: 4 }];
    },
  };
  const adapter = {
    authorizeDestination: async () => {
      authorizations += 1;
      return "allow";
    },
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
    assert.equal(authorizations, 0);
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
