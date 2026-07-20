import {
  createSandboxInteractiveHelper,
  parseSandboxInteractiveControl,
} from "./sandbox-interactive-helper.mjs";

import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import test from "node:test";

const identity = {
  channelId: "channel-1",
  commandId: "command-1",
  generation: 3,
};

function launch(overrides = {}) {
  const root = "/private/tmp/agentlink-interactive";
  return {
    ...identity,
    version: 1,
    type: "launch",
    command: "/usr/bin/true",
    cwd: root,
    shell: "/bin/bash",
    environment: {
      HOME: `${root}/home`,
      TMPDIR: `${root}/tmp`,
      TERM: "xterm-256color",
    },
    filesystem: {
      denyRead: ["/Users/example"],
      allowRead: [root],
      allowWrite: [root],
      denyWrite: [],
    },
    network: { mode: "blocked" },
    protectedRoots: [],
    dimensions: { columns: 80, rows: 24 },
    ...overrides,
  };
}

function disposable(set, listener) {
  set.add(listener);
  return { dispose: () => set.delete(listener) };
}

function createHarness({
  initialData,
  initialExit,
  throwOnDataDispose = false,
  runtimeOverrides = {},
} = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const dataListeners = new Set();
  const exitListeners = new Set();
  const signals = [];
  const calls = {
    writes: [],
    resizes: [],
    spawn: [],
    initialize: [],
    prepared: [],
    revalidated: [],
    proxyAllowlist: [],
    proxyClose: 0,
    replacedEnvironment: [],
    cleanup: 0,
    reset: 0,
  };
  let outputText = "";
  let errorText = "";
  output.on("data", (chunk) => (outputText += chunk.toString("utf8")));
  errorOutput.on("data", (chunk) => (errorText += chunk.toString("utf8")));

  const terminal = {
    pid: 4242,
    write(data) {
      calls.writes.push(data);
    },
    resize(columns, rows) {
      calls.resizes.push([columns, rows]);
    },
    kill(signal) {
      signals.push([this.pid, signal, "pty"]);
    },
    onData(listener) {
      const registration = disposable(dataListeners, listener);
      if (initialData !== undefined) listener(initialData);
      return throwOnDataDispose
        ? {
            dispose() {
              registration.dispose();
              throw new Error("data disposal failed");
            },
          }
        : registration;
    },
    onExit(listener) {
      const registration = disposable(exitListeners, listener);
      if (initialExit !== undefined) listener(initialExit);
      return registration;
    },
    emitData(data) {
      for (const listener of dataListeners) listener(data);
    },
    emitExit(event) {
      for (const listener of exitListeners) listener(event);
    },
  };

  const runtime = {
    async initialize(config) {
      calls.initialize.push(config);
    },
    async wrapWithSandboxArgv() {
      const httpProxy = "http://localhost:43101";
      const socksProxy = "socks5h://localhost:43102";
      return {
        argv: [
          "/bin/bash",
          "-c",
          `env ${Array.from({ length: 8 }, () => httpProxy).join(" ")} ${Array.from({ length: 4 }, () => socksProxy).join(" ")} /usr/bin/sandbox-exec -p profile /bin/bash -c /usr/bin/true`,
        ],
      };
    },
    cleanupAfterCommand() {
      calls.cleanup += 1;
    },
    async reset() {
      calls.reset += 1;
    },
    ...runtimeOverrides,
  };
  const timers = new Set();
  const helper = createSandboxInteractiveHelper({
    input,
    output,
    errorOutput,
    dependencies: {
      platform: "darwin",
      async realpath(value) {
        return value;
      },
      async prepareProtectedRoots(roots) {
        calls.prepared.push(roots);
        return { roots, snapshots: [] };
      },
      async revalidateProtectedRoots(prepared) {
        calls.revalidated.push(prepared);
      },
      replaceProcessEnvironment(environment) {
        calls.replacedEnvironment.push(environment);
      },
      async startTrustedNetworkProxies(allowedDomains) {
        calls.proxyAllowlist.push(allowedDomains);
        return {
          httpPort: 43101,
          socksPort: 43102,
          credentials: {
            username: "agentlink",
            password: "a".repeat(64),
          },
          async close() {
            calls.proxyClose += 1;
          },
        };
      },
      async loadRuntime() {
        return runtime;
      },
      async loadNodePty() {
        return {
          spawn(...args) {
            calls.spawn.push(args);
            return terminal;
          },
        };
      },
      kill(pid, signal) {
        signals.push([pid, signal, "group"]);
      },
      setTimeout(callback) {
        const timer = { callback, unref() {} };
        timers.add(timer);
        return timer;
      },
      clearTimeout(timer) {
        timers.delete(timer);
      },
    },
  });

  const frames = () =>
    outputText
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const send = (frame) => input.write(`${JSON.stringify(frame)}\n`);
  const waitFor = async (predicate, message = "expected helper state") => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(`timed out waiting for ${message}`);
  };

  return {
    input,
    helper,
    terminal,
    calls,
    signals,
    timers,
    frames,
    send,
    waitFor,
    errorText: () => errorText,
  };
}

test("validates exact control-frame keys and bounds", () => {
  assert.deepEqual(parseSandboxInteractiveControl(launch()), launch());
  assert.throws(
    () => parseSandboxInteractiveControl({ ...launch(), authority: "host" }),
    /invalid sandbox helper launch frame/,
  );
  assert.throws(
    () =>
      parseSandboxInteractiveControl({
        ...identity,
        type: "resize",
        dimensions: { columns: 80, rows: 24, pixels: 1 },
      }),
    /invalid sandbox helper resize frame/,
  );
  assert.throws(
    () => parseSandboxInteractiveControl({ ...identity, type: "unknown" }),
    /invalid sandbox helper control frame/,
  );
  assert.throws(
    () =>
      parseSandboxInteractiveControl({
        ...identity,
        type: "input",
        data: "x".repeat(256 * 1024 + 1),
      }),
    /invalid sandbox helper input frame/,
  );
});

test("launches blocked networking with a private environment and emits ready before data", async (t) => {
  const harness = createHarness({ initialData: "early output" });
  t.after(() => harness.helper.close());

  harness.send(launch());
  await harness.waitFor(() =>
    harness.frames().some((frame) => frame.type === "data"),
  );

  const frames = harness.frames();
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ["ready", "data"],
  );
  assert.deepEqual(
    frames.map(({ channelId, commandId, generation }) => ({
      channelId,
      commandId,
      generation,
    })),
    [identity, identity],
  );
  assert.equal(frames[0].pid, 4242);
  assert.equal(frames[0].pgid, 4242);
  assert.equal(frames[0].backend, "seatbelt");
  assert.equal(harness.calls.spawn[0][0], "/bin/bash");
  assert.equal(harness.calls.spawn[0][1][0], "-c");
  assert.match(
    harness.calls.spawn[0][1][1],
    /http:\/\/agentlink:a{64}@localhost:43101/,
  );
  assert.match(
    harness.calls.spawn[0][1][1],
    /socks5h:\/\/agentlink:a{64}@localhost:43102/,
  );
  assert.deepEqual(harness.calls.replacedEnvironment, [
    {
      HOME: "/private/tmp/agentlink-interactive/home",
      TMPDIR: "/private/tmp/agentlink-interactive/tmp",
      TERM: "xterm-256color",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      CLAUDE_CODE_TMPDIR: "/private/tmp/agentlink-interactive/tmp",
    },
  ]);
  assert.deepEqual(harness.calls.spawn[0][2].env, {
    HOME: "/private/tmp/agentlink-interactive/home",
    TMPDIR: "/private/tmp/agentlink-interactive/tmp",
    TERM: "xterm-256color",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    CLAUDE_CODE_TMPDIR: "/private/tmp/agentlink-interactive/tmp",
  });
  assert.equal(harness.calls.initialize[0].allowPty, true);
  assert.deepEqual(harness.calls.initialize[0].network, {
    allowedDomains: [],
    deniedDomains: [],
    strictAllowlist: true,
    allowUnixSockets: [],
    allowAllUnixSockets: false,
    allowLocalBinding: false,
    allowMachLookup: [],
    httpProxyPort: 43101,
    socksProxyPort: 43102,
  });
  assert.deepEqual(harness.calls.proxyAllowlist, [[]]);
  assert.equal(harness.calls.revalidated.length, 1);
});

test("chunks PTY data at the protocol byte bound", async (t) => {
  const data = `${"x".repeat(256 * 1024)}é`;
  const harness = createHarness({ initialData: data });
  t.after(() => harness.helper.close());

  harness.send(launch());
  await harness.waitFor(
    () =>
      harness.frames().filter((frame) => frame.type === "data").length === 2,
  );

  const dataFrames = harness.frames().filter((frame) => frame.type === "data");
  assert.equal(dataFrames.map((frame) => frame.data).join(""), data);
  assert.equal(
    dataFrames.every((frame) => Buffer.byteLength(frame.data) <= 256 * 1024),
    true,
  );
});

test("emits ready before a synchronous PTY exit", async (t) => {
  const harness = createHarness({ initialExit: { exitCode: 0 } });
  t.after(() => harness.helper.close());

  harness.send(launch());
  await harness.waitFor(() =>
    harness.frames().some((frame) => frame.type === "exit"),
  );

  assert.deepEqual(
    harness.frames().map((frame) => frame.type),
    ["ready", "exit"],
  );
  assert.equal(harness.calls.cleanup, 1);
  assert.equal(harness.calls.reset, 1);
  assert.equal(harness.calls.proxyClose, 1);
});

test("routes input, resize, interrupt, and terminate to the PTY process group", async (t) => {
  const harness = createHarness();
  t.after(() => harness.helper.close());
  harness.send(launch());
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");

  harness.send({ ...identity, type: "input", data: "hello\n" });
  harness.send({
    ...identity,
    type: "resize",
    dimensions: { columns: 132, rows: 40 },
  });
  harness.send({ ...identity, type: "interrupt" });
  harness.send({ ...identity, type: "terminate" });
  await harness.waitFor(() => harness.signals.length === 2);

  assert.deepEqual(harness.calls.writes, ["hello\n"]);
  assert.deepEqual(harness.calls.resizes, [[132, 40]]);
  assert.deepEqual(harness.signals, [
    [-4242, "SIGINT", "group"],
    [-4242, "SIGTERM", "group"],
  ]);
  assert.equal(harness.timers.size, 1);
});

test("preserves an accepted interrupt when the PTY shell exits normally", async (t) => {
  const harness = createHarness();
  t.after(() => harness.helper.close());
  harness.send(launch());
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");

  harness.send({ ...identity, type: "interrupt" });
  await harness.waitFor(() => harness.signals.length === 1);
  harness.terminal.emitExit({ exitCode: 0, signal: 0 });
  await harness.waitFor(() =>
    harness.frames().some((frame) => frame.type === "exit"),
  );

  assert.deepEqual(harness.frames().at(-1), {
    ...identity,
    type: "exit",
    exitCode: 130,
    signal: 2,
    timedOut: false,
  });
});

test("canonicalizes a PTY-reported SIGINT after an accepted interrupt", async (t) => {
  const harness = createHarness();
  t.after(() => harness.helper.close());
  harness.send(launch());
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");

  harness.send({ ...identity, type: "interrupt" });
  await harness.waitFor(() => harness.signals.length === 1);
  harness.terminal.emitExit({ exitCode: 0, signal: 2 });
  await harness.waitFor(() =>
    harness.frames().some((frame) => frame.type === "exit"),
  );

  assert.deepEqual(harness.frames().at(-1), {
    ...identity,
    type: "exit",
    exitCode: 130,
    signal: 2,
    timedOut: false,
  });
});

test("preserves an unrelated PTY signal after an accepted interrupt", async (t) => {
  const harness = createHarness();
  t.after(() => harness.helper.close());
  harness.send(launch());
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");

  harness.send({ ...identity, type: "interrupt" });
  await harness.waitFor(() => harness.signals.length === 1);
  harness.terminal.emitExit({ exitCode: 0, signal: 15 });
  await harness.waitFor(() =>
    harness.frames().some((frame) => frame.type === "exit"),
  );

  assert.deepEqual(harness.frames().at(-1), {
    ...identity,
    type: "exit",
    exitCode: 0,
    signal: 15,
    timedOut: false,
  });
});

test("rejects stale command identities and terminates the active group", async (t) => {
  const harness = createHarness();
  t.after(() => harness.helper.close());
  harness.send(launch());
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");

  harness.send({ ...identity, generation: 2, type: "input", data: "stale" });
  await harness.waitFor(() =>
    harness.frames().some((frame) => frame.type === "error"),
  );

  assert.equal(harness.calls.writes.length, 0);
  assert.match(harness.frames().at(-1).message, /stale command identity/);
  assert.deepEqual(harness.signals, [[-4242, "SIGTERM", "group"]]);

  harness.terminal.emitData("late data");
  harness.terminal.emitExit({ exitCode: 143, signal: 15 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    harness.frames().map((frame) => frame.type),
    ["ready", "error"],
  );
});

test("malformed and unknown frames fail closed without reaching the PTY", async (t) => {
  const malformed = createHarness();
  t.after(() => malformed.helper.close());
  malformed.send(launch());
  await malformed.waitFor(() => malformed.frames()[0]?.type === "ready");
  malformed.input.write("not-json\n");
  await malformed.waitFor(() =>
    malformed.frames().some((frame) => frame.type === "error"),
  );
  assert.match(malformed.frames().at(-1).message, /malformed JSON/);
  assert.deepEqual(malformed.signals, [[-4242, "SIGTERM", "group"]]);

  const unknown = createHarness();
  t.after(() => unknown.helper.close());
  unknown.send(launch());
  await unknown.waitFor(() => unknown.frames()[0]?.type === "ready");
  unknown.send({ ...identity, type: "unknown" });
  await unknown.waitFor(() =>
    unknown.frames().some((frame) => frame.type === "error"),
  );
  assert.match(
    unknown.frames().at(-1).message,
    /invalid sandbox helper control frame/,
  );
  assert.equal(unknown.calls.writes.length, 0);
});

test("emits exactly one exit and performs cleanup once", async (t) => {
  const harness = createHarness();
  t.after(() => harness.helper.close());
  harness.send(launch());
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");

  harness.terminal.emitExit({ exitCode: 7, signal: 15 });
  harness.terminal.emitExit({ exitCode: 9, signal: 9 });
  await harness.waitFor(() => harness.calls.reset === 1);

  const exits = harness.frames().filter((frame) => frame.type === "exit");
  assert.deepEqual(exits, [
    {
      ...identity,
      type: "exit",
      exitCode: 7,
      signal: 15,
      timedOut: false,
    },
  ]);
  assert.equal(harness.calls.cleanup, 1);
  assert.equal(harness.calls.reset, 1);

  harness.send({ ...identity, generation: 2, type: "input", data: "late" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    harness.frames().filter((frame) => frame.type === "error").length,
    0,
  );
});

test("resets the runtime when subscription disposal fails", async (t) => {
  const harness = createHarness({ throwOnDataDispose: true });
  t.after(() => harness.helper.close());
  harness.send(launch());
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");

  harness.terminal.emitExit({ exitCode: 0 });
  await harness.waitFor(() => harness.calls.reset === 1);

  assert.equal(harness.calls.cleanup, 1);
  assert.equal(harness.calls.reset, 1);
  await harness.waitFor(() => /data disposal failed/.test(harness.errorText()));
});

test("fails public-proxy closed before runtime initialization", async (t) => {
  const harness = createHarness();
  t.after(() => harness.helper.close());
  harness.send(launch({ network: { mode: "public-proxy" } }));
  await harness.waitFor(() => harness.frames()[0]?.type === "error");

  assert.match(harness.frames()[0].message, /public-proxy mode is unavailable/);
  assert.equal(harness.calls.initialize.length, 0);
  assert.equal(harness.calls.spawn.length, 0);
});
