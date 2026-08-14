import {
  createSandboxInteractiveHelper,
  parseSandboxInteractiveControl,
} from "./sandbox-interactive-helper.mjs";
import { link, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import {
  prepareProtectedRoots,
  revalidateProtectedRoots,
  validateStructurallyProtectedRoots,
} from "./sandbox-protected-roots.mjs";

import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

const identity = {
  channelId: "channel-1",
  commandId: "command-1",
  generation: 3,
};

function launch(overrides = {}) {
  const root = "/private/tmp/agentlink-interactive";
  return {
    ...identity,
    version: 3,
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
    network: { mode: "loopback" },
    protectedRoots: [],
    structurallyProtectedRoots: [],
    dimensions: { columns: 80, rows: 24 },
    ...overrides,
  };
}

function disposable(set, listener) {
  set.add(listener);
  return { dispose: () => set.delete(listener) };
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

function createHarness({
  initialData,
  initialExit,
  throwOnDataDispose = false,
  runtimeOverrides = {},
  dependencyOverrides = {},
} = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const dataListeners = new Set();
  const exitListeners = new Set();
  const signals = [];
  const delays = [];
  const calls = {
    writes: [],
    resizes: [],
    spawn: [],
    initialize: [],
    prepared: [],
    revalidated: [],
    structurallyValidated: [],
    proxyAllowlist: [],
    proxyOptions: [],
    proxyClose: 0,
    replacedEnvironment: [],
    pauses: 0,
    resumes: 0,
    cleanup: 0,
    reset: 0,
    order: [],
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
    pause() {
      calls.pauses += 1;
    },
    resume() {
      calls.resumes += 1;
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

  const loopbackRules = [
    '(allow network-bind (local ip "*:*"))',
    '(allow network-inbound (local ip "*:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
  ].join("\n");
  const runtime = {
    async initialize(config) {
      calls.order.push("initialize");
      calls.initialize.push(config);
    },
    async wrapWithSandboxArgv() {
      calls.order.push("wrap");
      const httpProxy = "http://localhost:43101";
      const socksProxy = "socks5h://localhost:43102";
      return {
        argv: [
          "/bin/bash",
          "-c",
          `env ${Array.from({ length: 8 }, () => httpProxy).join(" ")} ${Array.from({ length: 4 }, () => socksProxy).join(" ")} /usr/bin/sandbox-exec -p '${loopbackRules}' /bin/bash -c /usr/bin/true`,
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
  let networkRequestIdsCreated = 0;
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
        calls.order.push("prepare");
        calls.prepared.push(roots);
        return { roots, snapshots: [] };
      },
      async revalidateProtectedRoots(prepared) {
        calls.order.push("revalidate");
        calls.revalidated.push(prepared);
      },
      async validateStructurallyProtectedRoots(roots) {
        calls.order.push("validate-structural");
        calls.structurallyValidated.push(roots);
        return roots;
      },
      replaceProcessEnvironment(environment) {
        calls.replacedEnvironment.push(environment);
      },
      async canonicalizeFilesystemPolicy(filesystem) {
        return filesystem;
      },
      async canonicalizeProtectedRootPolicy() {},
      assertProtectedRootsCovered() {},
      async startTrustedNetworkProxies(
        allowedDomains,
        _resolverOptions,
        options,
      ) {
        calls.proxyAllowlist.push(allowedDomains);
        calls.proxyOptions.push(options);
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
      createNetworkRequestId: () => `network-${++networkRequestIdsCreated}`,
      async delay(milliseconds) {
        delays.push(milliseconds);
      },
      async loadRuntime() {
        return runtime;
      },
      async loadNodePty() {
        calls.order.push("load-node-pty");
        return {
          spawn(...args) {
            calls.order.push("spawn");
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
      ...dependencyOverrides,
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
    output,
    helper,
    terminal,
    calls,
    signals,
    delays,
    timers,
    frames,
    networkRequestIdsCreated: () => networkRequestIdsCreated,
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
      parseSandboxInteractiveControl(
        launch({
          network: {
            mode: "public-proxy",
            allowedDomains: ["private.example"],
          },
        }),
      ),
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
  assert.deepEqual(
    parseSandboxInteractiveControl({
      ...identity,
      type: "network-decision",
      requestId: "network-1",
      decision: "allow-once",
    }),
    {
      ...identity,
      type: "network-decision",
      requestId: "network-1",
      decision: "allow-once",
    },
  );
  assert.throws(
    () =>
      parseSandboxInteractiveControl({
        ...identity,
        type: "network-decision",
        requestId: "network-1",
        decision: "allow",
      }),
    /invalid sandbox helper network decision frame/,
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

test("cancels delayed startup before PTY spawn", async (t) => {
  const runtimeLoaded = deferred();
  const harness = createHarness({
    dependencyOverrides: {
      loadRuntime: () => runtimeLoaded.promise,
    },
  });
  t.after(() => harness.helper.close());

  harness.send(launch());
  await harness.waitFor(
    () => harness.helper.activeIdentity?.commandId === identity.commandId,
    "active launch identity",
  );
  harness.send({ ...identity, type: "terminate" });
  runtimeLoaded.resolve({
    async initialize() {},
    async wrapWithSandboxArgv() {
      throw new Error("cancelled startup must not prepare a PTY");
    },
    cleanupAfterCommand() {
      harness.calls.cleanup += 1;
    },
    async reset() {
      harness.calls.reset += 1;
    },
  });

  await harness.waitFor(
    () => harness.frames().some((frame) => frame.type === "error"),
    "startup cancellation error",
  );
  assert.match(
    harness.frames().find((frame) => frame.type === "error").message,
    /cancelled before initialization/,
  );
  assert.equal(harness.calls.spawn.length, 0);
  assert.equal(harness.calls.proxyAllowlist.length, 0);
  assert.equal(harness.calls.cleanup, 1);
  assert.equal(harness.calls.reset, 1);
});

test("waits for delayed startup before helper shutdown completes", async () => {
  const runtimeLoaded = deferred();
  const harness = createHarness({
    dependencyOverrides: {
      loadRuntime: () => runtimeLoaded.promise,
    },
  });

  harness.send(launch());
  await harness.waitFor(
    () => harness.helper.activeIdentity?.commandId === identity.commandId,
    "active launch identity",
  );
  const closing = harness.helper.close();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);

  runtimeLoaded.resolve({
    async initialize() {},
    async wrapWithSandboxArgv() {
      throw new Error("closed startup must not prepare a PTY");
    },
    cleanupAfterCommand() {
      harness.calls.cleanup += 1;
    },
    async reset() {
      harness.calls.reset += 1;
    },
  });
  await closing;

  assert.equal(harness.calls.spawn.length, 0);
  assert.equal(harness.calls.cleanup, 1);
  assert.equal(harness.calls.reset, 1);
});

test("launches loopback networking with a private environment and emits ready before data", async (t) => {
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
  assert.doesNotMatch(harness.calls.spawn[0][1][1], /allow network-bind/);
  assert.doesNotMatch(harness.calls.spawn[0][1][1], /allow network-inbound/);
  assert.match(harness.calls.spawn[0][1][1], /allow network-outbound/);
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
    allowLocalBinding: true,
    allowMachLookup: [],
    httpProxyPort: 43101,
    socksProxyPort: 43102,
  });
  assert.deepEqual(harness.calls.proxyAllowlist, [[]]);
  assert.equal(harness.calls.revalidated.length, 1);
  assert.deepEqual(harness.calls.order, [
    "initialize",
    "wrap",
    "load-node-pty",
    "prepare",
    "revalidate",
    "validate-structural",
    "spawn",
  ]);
});

test("retries one legacy node-pty spawn failure before command readiness", async (t) => {
  let attempts = 0;
  const harness = createHarness({
    dependencyOverrides: {
      async loadNodePty() {
        harness.calls.order.push("load-node-pty");
        return {
          spawn(...args) {
            attempts += 1;
            harness.calls.order.push("spawn");
            harness.calls.spawn.push(args);
            if (attempts === 1) throw new Error("posix_spawnp failed.");
            return harness.terminal;
          },
        };
      },
    },
  });
  t.after(() => harness.helper.close());

  harness.send(launch());
  await harness.waitFor(() =>
    harness.frames().some((frame) => frame.type === "ready"),
  );

  assert.equal(attempts, 2);
  assert.deepEqual(harness.delays, [25]);
  assert.deepEqual(
    harness.frames().map((frame) => frame.type),
    ["ready"],
  );
});

test("reports repeated legacy node-pty spawn failure as pre-launch", async (t) => {
  const harness = createHarness({
    dependencyOverrides: {
      async loadNodePty() {
        harness.calls.order.push("load-node-pty");
        return {
          spawn(...args) {
            harness.calls.order.push("spawn");
            harness.calls.spawn.push(args);
            throw new Error("posix_spawnp failed.");
          },
        };
      },
    },
  });
  t.after(() => harness.helper.close());

  harness.send(launch());
  await harness.waitFor(() =>
    harness.frames().some((frame) => frame.type === "error"),
  );

  assert.equal(harness.calls.spawn.length, 2);
  assert.deepEqual(harness.delays, [25]);
  assert.match(
    harness.frames().find((frame) => frame.type === "error").message,
    /failed twice before the command started/,
  );
  assert.equal(harness.calls.cleanup, 1);
  assert.equal(harness.calls.reset, 1);
});

test("does not expand protected roots into the sandbox profile", async (t) => {
  const sandboxRoot = "/private/tmp/agentlink-interactive";
  const policyRoot = path.join(sandboxRoot, ".claude");
  const protectedRoots = Array.from({ length: 10_000 }, (_, index) =>
    path.join(policyRoot, "skills", `skill-${index}`, "SKILL.md"),
  );
  const harness = createHarness();
  t.after(() => harness.helper.close());

  harness.send(
    launch({
      filesystem: {
        denyRead: [],
        allowRead: [sandboxRoot],
        allowWrite: [sandboxRoot],
        denyWrite: [policyRoot],
      },
      protectedRoots,
    }),
  );
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");

  assert.deepEqual(harness.calls.initialize[0].filesystem.denyWrite, [
    policyRoot,
  ]);
  assert.equal(
    JSON.stringify(harness.calls.initialize[0]).includes("skill-9999"),
    false,
  );
  assert.equal(harness.calls.spawn.length, 1);
});

test("fails before runtime initialization when canonical protected roots escape deny-write coverage", async (t) => {
  const harness = createHarness({
    dependencyOverrides: {
      async canonicalizeProtectedRootPolicy() {
        throw new Error("canonical protected root must be covered");
      },
    },
  });
  t.after(() => harness.helper.close());

  harness.send(launch());
  await harness.waitFor(() => harness.frames()[0]?.type === "error");

  assert.match(harness.frames()[0].message, /canonical protected root/);
  assert.equal(harness.calls.initialize.length, 0);
  assert.equal(harness.calls.spawn.length, 0);
});

test("rechecks canonical protected-root coverage immediately before spawn", async (t) => {
  let coverageChecks = 0;
  const harness = createHarness({
    dependencyOverrides: {
      assertProtectedRootsCovered() {
        coverageChecks += 1;
        throw new Error("canonical coverage changed before spawn");
      },
    },
  });
  t.after(() => harness.helper.close());

  harness.send(launch());
  await harness.waitFor(() => harness.frames()[0]?.type === "error");

  assert.match(harness.frames()[0].message, /coverage changed before spawn/);
  assert.equal(coverageChecks, 1);
  assert.equal(harness.calls.initialize.length, 1);
  assert.equal(harness.calls.spawn.length, 0);
});

test("does not retry a non-legacy PTY spawn failure", async (t) => {
  const harness = createHarness({
    dependencyOverrides: {
      async loadNodePty() {
        harness.calls.order.push("load-node-pty");
        return {
          spawn(...args) {
            harness.calls.order.push("spawn");
            harness.calls.spawn.push(args);
            throw new Error("posix_spawn failed: Exec format error");
          },
        };
      },
    },
  });
  t.after(() => harness.helper.close());

  harness.send(launch());
  await harness.waitFor(() =>
    harness.frames().some((frame) => frame.type === "error"),
  );

  assert.equal(harness.calls.spawn.length, 1);
  assert.deepEqual(harness.delays, []);
  assert.match(
    harness.frames().find((frame) => frame.type === "error").message,
    /Exec format error/,
  );
});

test("allows host history bootstrap to settle before the late protected-root snapshot", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "al-h-"));
  const agentlinkRoot = path.join(fixture, ".agentlink");
  const historyRoot = path.join(agentlinkRoot, "history");
  const historyFile = path.join(historyRoot, "sessions.json");
  const policyFile = path.join(agentlinkRoot, "policy.json");
  const gitignoreFile = path.join(agentlinkRoot, ".gitignore");
  await mkdir(historyRoot, { recursive: true });
  await writeFile(historyFile, "[]");
  await writeFile(policyFile, "policy-original");
  await writeFile(gitignoreFile, "history/\n");

  const harness = createHarness({
    runtimeOverrides: {
      async initialize(config) {
        harness.calls.order.push("initialize");
        harness.calls.initialize.push(config);
        const historyTemp = path.join(historyRoot, ".sessions.atomic.tmp");
        await writeFile(historyTemp, '[{"id":"session-1"}]');
        await rename(historyTemp, historyFile);
        await writeFile(
          gitignoreFile,
          "history/\ntranscripts/\ndebug/\ncheckpoints/\n",
        );
      },
    },
    dependencyOverrides: {
      async prepareProtectedRoots(roots) {
        harness.calls.order.push("prepare");
        harness.calls.prepared.push(roots);
        return prepareProtectedRoots(roots);
      },
      async revalidateProtectedRoots(prepared) {
        harness.calls.order.push("revalidate");
        harness.calls.revalidated.push(prepared);
        return revalidateProtectedRoots(prepared);
      },
    },
  });
  t.after(async () => {
    harness.helper.close();
    await rm(fixture, { recursive: true, force: true });
  });

  harness.send(
    launch({
      cwd: fixture,
      environment: {
        HOME: path.join(fixture, "home"),
        TMPDIR: path.join(fixture, "tmp"),
        TERM: "xterm-256color",
      },
      filesystem: {
        denyRead: [],
        allowRead: [fixture],
        allowWrite: [fixture],
        denyWrite: [agentlinkRoot],
      },
      protectedRoots: [gitignoreFile, policyFile],
    }),
  );
  await harness.waitFor(() => harness.frames().length > 0);
  assert.equal(
    harness.frames()[0]?.type,
    "ready",
    JSON.stringify(harness.frames()[0]),
  );

  assert.equal(harness.calls.spawn.length, 1);
  assert.deepEqual(harness.calls.initialize[0].filesystem.denyWrite, [
    agentlinkRoot,
  ]);
  assert.deepEqual(harness.calls.order, [
    "initialize",
    "wrap",
    "load-node-pty",
    "prepare",
    "revalidate",
    "validate-structural",
    "spawn",
  ]);
});

test("allows host Git ref replacement before late structural validation", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "al-g-"));
  const gitRoot = path.join(fixture, ".git");
  const refRoot = path.join(gitRoot, "refs", "remotes", "origin");
  const ref = path.join(refRoot, "main");
  await mkdir(refRoot, { recursive: true });
  await writeFile(ref, "a".repeat(40));

  const harness = createHarness({
    runtimeOverrides: {
      async initialize(config) {
        harness.calls.order.push("initialize");
        harness.calls.initialize.push(config);
        const temporaryRef = path.join(refRoot, ".main.lock");
        await writeFile(temporaryRef, "b".repeat(40));
        await rename(temporaryRef, ref);
      },
    },
    dependencyOverrides: {
      async validateStructurallyProtectedRoots(roots) {
        harness.calls.order.push("validate-structural");
        harness.calls.structurallyValidated.push(roots);
        return validateStructurallyProtectedRoots(roots);
      },
    },
  });
  t.after(async () => {
    harness.helper.close();
    await rm(fixture, { recursive: true, force: true });
  });

  harness.send(
    launch({
      cwd: fixture,
      environment: {
        HOME: path.join(fixture, "home"),
        TMPDIR: path.join(fixture, "tmp"),
        TERM: "xterm-256color",
      },
      filesystem: {
        denyRead: [],
        allowRead: [fixture],
        allowWrite: [fixture],
        denyWrite: [gitRoot],
      },
      structurallyProtectedRoots: [gitRoot],
    }),
  );
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");

  assert.equal(harness.calls.spawn.length, 1);
  assert.deepEqual(harness.calls.structurallyValidated, [[gitRoot]]);
  assert.deepEqual(harness.calls.order, [
    "initialize",
    "wrap",
    "load-node-pty",
    "prepare",
    "revalidate",
    "validate-structural",
    "spawn",
  ]);
});

test("fails closed when structural validation finds a Git hard-link alias", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "al-a-"));
  const gitRoot = path.join(fixture, ".git");
  const refRoot = path.join(gitRoot, "refs", "heads");
  const ref = path.join(refRoot, "main");
  await mkdir(refRoot, { recursive: true });
  await writeFile(ref, "a".repeat(40));
  await link(ref, path.join(fixture, "ref-alias"));

  const harness = createHarness({
    dependencyOverrides: {
      async validateStructurallyProtectedRoots(roots) {
        harness.calls.order.push("validate-structural");
        harness.calls.structurallyValidated.push(roots);
        return validateStructurallyProtectedRoots(roots);
      },
    },
  });
  t.after(async () => {
    harness.helper.close();
    await rm(fixture, { recursive: true, force: true });
  });

  harness.send(
    launch({
      cwd: fixture,
      environment: {
        HOME: path.join(fixture, "home"),
        TMPDIR: path.join(fixture, "tmp"),
        TERM: "xterm-256color",
      },
      filesystem: {
        denyRead: [],
        allowRead: [fixture],
        allowWrite: [fixture],
        denyWrite: [gitRoot],
      },
      structurallyProtectedRoots: [gitRoot],
    }),
  );
  await harness.waitFor(() => harness.frames()[0]?.type === "error");

  assert.match(
    harness.frames()[0].message,
    /structurally protected file has unexpected hard-link count 2/,
  );
  assert.equal(harness.calls.spawn.length, 0);
  assert.deepEqual(harness.calls.order, [
    "initialize",
    "wrap",
    "load-node-pty",
    "prepare",
    "revalidate",
    "validate-structural",
  ]);
});

test("fails closed when a protected file changes after the late snapshot", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "al-p-"));
  const policyFile = path.join(fixture, "policy.json");
  await writeFile(policyFile, "policy-original");

  const harness = createHarness({
    dependencyOverrides: {
      async prepareProtectedRoots(roots) {
        harness.calls.order.push("prepare");
        harness.calls.prepared.push(roots);
        const prepared = await prepareProtectedRoots(roots);
        await writeFile(policyFile, "policy-mutated");
        return prepared;
      },
      async revalidateProtectedRoots(prepared) {
        harness.calls.order.push("revalidate");
        harness.calls.revalidated.push(prepared);
        return revalidateProtectedRoots(prepared);
      },
    },
  });
  t.after(async () => {
    harness.helper.close();
    await rm(fixture, { recursive: true, force: true });
  });

  harness.send(
    launch({
      cwd: fixture,
      environment: {
        HOME: path.join(fixture, "home"),
        TMPDIR: path.join(fixture, "tmp"),
        TERM: "xterm-256color",
      },
      filesystem: {
        denyRead: [],
        allowRead: [fixture],
        allowWrite: [fixture],
        denyWrite: [policyFile],
      },
      protectedRoots: [policyFile],
    }),
  );
  await harness.waitFor(() => harness.frames()[0]?.type === "error");

  assert.match(
    harness.frames()[0].message,
    /protected root contents changed before spawn: root=.*policy\.json path=\. change=modified/,
  );
  assert.equal(harness.calls.spawn.length, 0);
  assert.deepEqual(harness.calls.order, [
    "initialize",
    "wrap",
    "load-node-pty",
    "prepare",
    "revalidate",
  ]);
});

test("pauses PTY output on protocol backpressure and resumes in frame order", async (t) => {
  const harness = createHarness();
  t.after(() => harness.helper.close());
  const originalWrite = harness.output.write.bind(harness.output);
  let backpressureOnce = true;
  harness.output.write = (chunk, ...args) => {
    originalWrite(chunk, ...args);
    if (!backpressureOnce) return true;
    backpressureOnce = false;
    return false;
  };

  harness.send(launch());
  await harness.waitFor(
    () => harness.frames().some((frame) => frame.type === "ready"),
    "ready frame",
  );
  assert.equal(harness.calls.pauses, 1);

  harness.terminal.emitData("first");
  harness.terminal.emitData("second");
  assert.deepEqual(
    harness.frames().filter((frame) => frame.type === "data"),
    [],
  );

  harness.output.emit("drain");
  await harness.waitFor(
    () =>
      harness.frames().filter((frame) => frame.type === "data").length === 2,
    "queued data frames",
  );
  assert.deepEqual(
    harness
      .frames()
      .filter((frame) => frame.type === "data")
      .map((frame) => frame.data),
    ["first", "second"],
  );
  assert.equal(harness.calls.resumes, 1);
});

test("fails closed when pre-ready PTY output exceeds the bounded buffer", async (t) => {
  const harness = createHarness({
    initialData: "x".repeat(2 * 1024 * 1024 + 1),
  });
  t.after(() => harness.helper.close());

  harness.send(launch());
  await harness.waitFor(
    () => harness.frames().some((frame) => frame.type === "error"),
    "pre-ready overflow error",
  );

  assert.match(
    harness.frames().find((frame) => frame.type === "error").message,
    /pre-ready output buffer limit exceeded/,
  );
  assert.deepEqual(harness.signals[0], [-4242, "SIGTERM", "group"]);
});

test("fails closed when queued output exceeds the backpressure bound", async (t) => {
  const harness = createHarness();
  t.after(() => harness.helper.close());
  const originalWrite = harness.output.write.bind(harness.output);
  let backpressureOnce = true;
  harness.output.write = (chunk, ...args) => {
    originalWrite(chunk, ...args);
    if (!backpressureOnce) return true;
    backpressureOnce = false;
    return false;
  };

  harness.send(launch());
  await harness.waitFor(
    () => harness.frames().some((frame) => frame.type === "ready"),
    "ready frame",
  );
  for (let index = 0; index < 9; index += 1) {
    harness.terminal.emitData("x".repeat(256 * 1024));
  }
  await harness.waitFor(
    () => harness.signals.length > 0,
    "overflow termination",
  );
  harness.output.emit("drain");
  await harness.waitFor(
    () => harness.frames().some((frame) => frame.type === "error"),
    "backpressure overflow error",
  );

  assert.match(
    harness.frames().find((frame) => frame.type === "error").message,
    /output backpressure limit exceeded/,
  );
  assert.deepEqual(harness.signals[0], [-4242, "SIGTERM", "group"]);
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

test("retains all localhost clauses for local binding", async (t) => {
  const harness = createHarness();
  t.after(() => harness.helper.close());
  harness.send(
    launch({ network: { mode: "loopback", allowLocalBinding: true } }),
  );
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");

  const wrapper = harness.calls.spawn[0][1][1];
  assert.match(wrapper, /allow network-bind/);
  assert.match(wrapper, /allow network-inbound/);
  assert.match(wrapper, /allow network-outbound/);
  assert.equal(harness.calls.initialize[0].network.allowLocalBinding, true);
});

test("launches public-proxy with a host-owned wildcard and redacts credentials from frames", async (t) => {
  const harness = createHarness();
  t.after(() => harness.helper.close());
  harness.send(launch({ network: { mode: "public-proxy" } }));
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");

  assert.deepEqual(harness.calls.proxyAllowlist, [["*"]]);
  assert.deepEqual(harness.calls.initialize[0].network, {
    allowedDomains: ["*"],
    deniedDomains: [],
    strictAllowlist: true,
    allowUnixSockets: [],
    allowAllUnixSockets: false,
    allowLocalBinding: true,
    allowMachLookup: [],
    httpProxyPort: 43101,
    socksProxyPort: 43102,
  });
  assert.equal(harness.calls.spawn.length, 1);
  const credential = "a".repeat(64);
  assert.match(harness.calls.spawn[0][1][1], new RegExp(credential));
  assert.equal(JSON.stringify(harness.frames()).includes(credential), false);
  assert.equal(harness.errorText().includes(credential), false);

  harness.terminal.emitExit({ exitCode: 0 });
  await harness.waitFor(() => harness.calls.proxyClose === 1);
  assert.equal(harness.calls.cleanup, 1);
  assert.equal(harness.calls.reset, 1);
});

test("pauses managed destinations until matching allow or reject decisions", async (t) => {
  const harness = createHarness();
  t.after(() => harness.helper.close());
  harness.send(launch({ network: { mode: "public-proxy" } }));
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");
  const authorize = harness.calls.proxyOptions[0].authorizeDestination;
  const destination = {
    host: "example.com",
    protocol: "https:",
    port: 443,
    address: "93.184.216.34",
    family: 4,
    answers: [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ],
  };

  const allowed = authorize(destination, new AbortController().signal);
  await harness.waitFor(
    () => harness.frames().some((frame) => frame.type === "network-request"),
    "managed network request",
  );
  const request = harness
    .frames()
    .find((frame) => frame.type === "network-request");
  assert.deepEqual(request, {
    ...identity,
    type: "network-request",
    request: {
      requestId: "network-1",
      host: "example.com",
      protocol: "https",
      port: 443,
      address: "93.184.216.34",
      family: 4,
      dnsAnswers: destination.answers,
      destinationClass: "public",
    },
  });
  harness.send({
    ...identity,
    type: "network-decision",
    requestId: "network-1",
    decision: "allow-once",
  });
  await assert.doesNotReject(
    allowed.then((decision) => assert.equal(decision, "allow")),
  );

  const rejected = authorize(
    { ...destination, protocol: "connect:", port: 8443 },
    new AbortController().signal,
  );
  await harness.waitFor(() =>
    harness
      .frames()
      .some(
        (frame) =>
          frame.type === "network-request" &&
          frame.request.requestId === "network-2",
      ),
  );
  const secondRequest = harness
    .frames()
    .find(
      (frame) =>
        frame.type === "network-request" &&
        frame.request.requestId === "network-2",
    );
  assert.equal(secondRequest.request.protocol, "tcp");
  harness.send({
    ...identity,
    type: "network-decision",
    requestId: "network-2",
    decision: "reject",
  });
  assert.equal(await rejected, "reject");
});

test("binds concurrent managed network decisions to exact request IDs", async (t) => {
  const harness = createHarness();
  t.after(() => harness.helper.close());
  harness.send(launch({ network: { mode: "public-proxy" } }));
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");
  const authorize = harness.calls.proxyOptions[0].authorizeDestination;
  const first = authorize(
    {
      host: "first.example",
      protocol: "https:",
      port: 443,
      address: "93.184.216.34",
      family: 4,
      answers: [{ address: "93.184.216.34", family: 4 }],
    },
    new AbortController().signal,
  );
  const second = authorize(
    {
      host: "second.example",
      protocol: "socks5:",
      port: 8443,
      address: "1.1.1.1",
      family: 4,
      answers: [{ address: "1.1.1.1", family: 4 }],
    },
    new AbortController().signal,
  );
  await harness.waitFor(
    () =>
      harness.frames().filter((frame) => frame.type === "network-request")
        .length === 2,
    "two managed network requests",
  );
  assert.deepEqual(
    harness
      .frames()
      .filter((frame) => frame.type === "network-request")
      .map((frame) => ({
        requestId: frame.request.requestId,
        host: frame.request.host,
      })),
    [
      { requestId: "network-1", host: "first.example" },
      { requestId: "network-2", host: "second.example" },
    ],
  );

  harness.send({
    ...identity,
    type: "network-decision",
    requestId: "network-2",
    decision: "allow-once",
  });
  assert.equal(await second, "allow");
  let firstSettled = false;
  void first.finally(() => {
    firstSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstSettled, false);

  harness.send({
    ...identity,
    type: "network-decision",
    requestId: "network-1",
    decision: "reject",
  });
  assert.equal(await first, "reject");
});

test("validates managed destinations before allocating request IDs", async (t) => {
  const harness = createHarness();
  t.after(() => harness.helper.close());
  harness.send(launch({ network: { mode: "public-proxy" } }));
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");
  const authorize = harness.calls.proxyOptions[0].authorizeDestination;

  await assert.rejects(
    authorize(
      {
        host: "example.com",
        protocol: "https:",
        port: 443,
        address: "93.184.216.34",
        family: 4,
        answers: [],
      },
      new AbortController().signal,
    ),
    /invalid managed network request/,
  );
  assert.equal(harness.networkRequestIdsCreated(), 0);
  assert.equal(
    harness.frames().some((frame) => frame.type === "network-request"),
    false,
  );
});

test("fails closed for stale-identity managed network decisions", async (t) => {
  const harness = createHarness();
  t.after(() => harness.helper.close());
  harness.send(launch({ network: { mode: "public-proxy" } }));
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");
  const pending = harness.calls.proxyOptions[0].authorizeDestination(
    {
      host: "example.com",
      protocol: "socks5:",
      port: 443,
      address: "93.184.216.34",
      family: 4,
      answers: [{ address: "93.184.216.34", family: 4 }],
    },
    new AbortController().signal,
  );
  await harness.waitFor(() =>
    harness.frames().some((frame) => frame.type === "network-request"),
  );
  const rejected = assert.rejects(
    pending,
    /managed network request was cancelled/,
  );

  harness.send({
    ...identity,
    generation: identity.generation + 1,
    type: "network-decision",
    requestId: "network-1",
    decision: "allow-once",
  });
  await harness.waitFor(
    () => harness.frames().some((frame) => frame.type === "error"),
    "stale-decision failure",
  );
  assert.match(
    harness.frames().find((frame) => frame.type === "error").message,
    /stale command identity/,
  );
  assert.deepEqual(harness.signals, [[-4242, "SIGTERM", "group"]]);
  harness.terminal.emitExit({ exitCode: 143, signal: 15 });
  await rejected;
});

test("cancels pending managed network requests when the helper closes", async () => {
  const harness = createHarness();
  harness.send(launch({ network: { mode: "public-proxy" } }));
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");
  const pending = harness.calls.proxyOptions[0].authorizeDestination(
    {
      host: "example.com",
      protocol: "http:",
      port: 80,
      address: "93.184.216.34",
      family: 4,
      answers: [{ address: "93.184.216.34", family: 4 }],
    },
    new AbortController().signal,
  );
  await harness.waitFor(() =>
    harness.frames().some((frame) => frame.type === "network-request"),
  );

  await harness.helper.close();
  await assert.rejects(pending, /managed network request was cancelled/);
  assert.equal(harness.calls.proxyClose, 1);
});

test("closes public-proxy once when the helper is closed repeatedly", async () => {
  const harness = createHarness();
  harness.send(launch({ network: { mode: "public-proxy" } }));
  await harness.waitFor(() => harness.frames()[0]?.type === "ready");

  await harness.helper.close();
  await harness.helper.close();
  assert.equal(harness.calls.cleanup, 1);
  assert.equal(harness.calls.reset, 1);
  assert.equal(harness.calls.proxyClose, 1);
});

test("closes public-proxy when runtime initialization fails", async (t) => {
  const harness = createHarness({
    runtimeOverrides: {
      async initialize(config) {
        harness.calls.order.push("initialize");
        harness.calls.initialize.push(config);
        throw new Error("initialization failed");
      },
    },
  });
  t.after(() => harness.helper.close());
  harness.send(launch({ network: { mode: "public-proxy" } }));
  await harness.waitFor(() => harness.frames()[0]?.type === "error");

  assert.match(harness.frames()[0].message, /initialization failed/);
  assert.equal(harness.calls.spawn.length, 0);
  assert.equal(harness.calls.cleanup, 1);
  assert.equal(harness.calls.reset, 1);
  assert.equal(harness.calls.proxyClose, 1);
});
