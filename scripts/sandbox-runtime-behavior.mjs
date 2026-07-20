import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, get as httpGet } from "node:http";
import { homedir, hostname } from "node:os";
import { spawn, spawnSync } from "node:child_process";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import path from "node:path";
import { spawn as spawnPty } from "node-pty";
import { startTrustedNetworkProxies } from "./sandbox-network-proxy.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = path.join(SCRIPT_DIR, "sandbox-runtime-helper.mjs");
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const NODE_PTY_SPAWN_HELPER = path.join(
  REPO_ROOT,
  "node_modules/node-pty/prebuilds",
  `darwin-${process.arch}`,
  "spawn-helper",
);
const DEFAULT_TIMEOUT_MS = 10_000;
const JOB_CONTROL_COMMAND = "printf 'READY\\n'; exec /bin/cat";
const strict = process.argv.includes("--strict");
const jsonOnly = process.argv.includes("--json");

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function percentile(values, fraction) {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

async function makeSandboxRoot(prefix) {
  const root = await mkdtemp(
    path.join("/private/tmp", `al-srt-gate-${prefix}-`),
  );
  await Promise.all([
    mkdir(path.join(root, "home"), { recursive: true }),
    mkdir(path.join(root, "tmp"), { recursive: true }),
    mkdir(path.join(root, "cache"), { recursive: true }),
  ]);
  return root;
}

function makeRequest(root, overrides = {}) {
  return {
    version: 1,
    operation: "execute",
    command: "/usr/bin/true",
    cwd: root,
    shell: "/bin/bash",
    environment: {
      HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      XDG_CACHE_HOME: path.join(root, "cache"),
    },
    filesystem: {
      denyRead: [homedir()],
      allowRead: [root],
      allowWrite: [root],
      denyWrite: [],
    },
    network: { allowedDomains: [] },
    protectedRoots: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...overrides,
  };
}

async function waitForPath(target, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(target);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${target}`);
}

async function runHelper(request) {
  const child = spawn(process.execPath, [HELPER_PATH], {
    cwd: REPO_ROOT,
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(request));
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const responseText = Buffer.concat(stdout).toString("utf8").trim();
  return {
    ...outcome,
    stderr: Buffer.concat(stderr).toString("utf8"),
    response: responseText ? JSON.parse(responseText) : undefined,
  };
}

function runPty(argv, environment, cwd, interaction, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const pty = spawnPty(argv[0], argv.slice(1), {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env: environment,
    });
    let output = "";
    let interactionComplete = false;
    let timedOut = false;
    let settled = false;
    let forceResolveTimeout;
    let dataSubscription;
    let exitSubscription;
    const finish = (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceResolveTimeout);
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      resolve({
        exitCode,
        signal,
        timedOut,
        output,
        durationMs: performance.now() - startedAt,
      });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        pty.kill("SIGKILL");
      } catch {}
      forceResolveTimeout = setTimeout(
        () => finish(undefined, "SIGKILL"),
        1_000,
      );
    }, timeoutMs);
    dataSubscription = pty.onData((data) => {
      output += data;
      if (!interactionComplete) {
        interactionComplete = interaction({ pty, output }) === true;
      }
    });
    exitSubscription = pty.onExit(({ exitCode, signal }) => {
      finish(exitCode, signal);
    });
  });
}

async function withPtyRuntime(root, operation) {
  const environment = {
    HOME: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
  };
  await SandboxManager.initialize({
    network: {
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowMachLookup: [],
    },
    filesystem: {
      denyRead: [homedir()],
      allowRead: [root],
      allowWrite: [root],
      denyWrite: [],
    },
    allowPty: true,
    allowAppleEvents: false,
    enableWeakerNetworkIsolation: false,
  });
  try {
    return await operation({
      environment,
      wrap: async (command) => {
        const descriptor = await SandboxManager.wrapWithSandboxArgv(
          command,
          "/bin/bash",
          undefined,
          undefined,
          root,
        );
        return descriptor.argv;
      },
    });
  } finally {
    try {
      SandboxManager.cleanupAfterCommand();
    } finally {
      await SandboxManager.reset();
    }
  }
}

async function probePtyBehavior() {
  const helperMetadata = await stat(NODE_PTY_SPAWN_HELPER);
  const hostHelperGate = {
    gate: "pty-host-spawn-helper-executable",
    passed: Boolean(helperMetadata.mode & 0o111),
    evidence: {
      path: path.relative(REPO_ROOT, NODE_PTY_SPAWN_HELPER),
      mode: (helperMetadata.mode & 0o777).toString(8).padStart(3, "0"),
    },
    limitation:
      "A present node-pty spawn-helper is unusable unless its executable mode survives install and packaging.",
  };
  if (!hostHelperGate.passed) {
    return [hostHelperGate];
  }
  let hostInterruptSent = false;
  const hostJobControl = await runPty(
    ["/bin/bash", "-c", JOB_CONTROL_COMMAND],
    { ...process.env, TERM: "xterm-256color" },
    REPO_ROOT,
    ({ pty, output }) => {
      if (!hostInterruptSent && output.includes("READY")) {
        hostInterruptSent = true;
        pty.write("\u0003");
        return true;
      }
      return false;
    },
    3_000,
  );
  const hostJobControlGate = {
    gate: "pty-host-job-control-baseline",
    passed:
      !hostJobControl.timedOut &&
      (hostJobControl.exitCode === 130 || hostJobControl.signal === 2),
    evidence: hostJobControl,
  };
  const root = await makeSandboxRoot("pty");
  try {
    const tuiFile = path.join(root, "tui.txt");
    await writeFile(tuiFile, "alpha\nbeta\n");
    const behaviorGates = await withPtyRuntime(
      root,
      async ({ environment, wrap }) => {
        const resizeArgv = await wrap(
          'test -t 0 && test -t 1 && printf "TTY=1\\nSIZE1=%s\\nREADY\\n" "$(stty size)" && IFS= read -r line && printf "SIZE2=%s\\nINPUT=%s\\n" "$(stty size)" "$line"',
        );
        let resizeSent = false;
        const resize = await runPty(
          resizeArgv,
          environment,
          root,
          ({ pty, output }) => {
            if (!resizeSent && output.includes("READY")) {
              resizeSent = true;
              pty.resize(100, 40);
              pty.write("hello-pty\r");
              return true;
            }
            return false;
          },
        );

        const jobArgv = await wrap(JOB_CONTROL_COMMAND);
        let interruptSent = false;
        const jobControl = await runPty(
          jobArgv,
          environment,
          root,
          ({ pty, output }) => {
            if (!interruptSent && output.includes("READY")) {
              interruptSent = true;
              pty.write("\u0003");
              return true;
            }
            return false;
          },
          3_000,
        );

        const tuiArgv = await wrap(
          `TERM=xterm-256color /usr/bin/less -R -X ${shellQuote(tuiFile)}`,
        );
        let quitSent = false;
        const tui = await runPty(
          tuiArgv,
          environment,
          root,
          ({ pty, output }) => {
            if (!quitSent && output.includes("alpha")) {
              quitSent = true;
              pty.write("q");
              return true;
            }
            return false;
          },
        );

        const resizePassed =
          resize.exitCode === 0 &&
          resize.output.includes("TTY=1") &&
          resize.output.includes("SIZE1=24 80") &&
          resize.output.includes("SIZE2=40 100") &&
          resize.output.includes("INPUT=hello-pty");
        const jobControlPassed =
          !jobControl.timedOut &&
          (jobControl.exitCode === 130 || jobControl.signal === 2);
        const tuiPassed =
          tui.exitCode === 0 && tui.output.includes("alpha") && quitSent;

        return [
          {
            gate: "pty-tty-resize-input",
            passed: resizePassed,
            evidence: resize,
            limitation:
              "This capability probe initializes the runtime with allowPty=true; the inactive pipe-based helper remains allowPty=false.",
          },
          {
            gate: "pty-job-control-foreground-sigint",
            passed: jobControlPassed,
            evidence: jobControl,
            limitation:
              "This capability probe initializes the runtime with allowPty=true; the inactive pipe-based helper remains allowPty=false.",
          },
          {
            gate: "pty-tui-pager",
            passed: tuiPassed,
            evidence: { ...tui, quitSent },
            limitation:
              "This capability probe initializes the runtime with allowPty=true; the inactive pipe-based helper remains allowPty=false.",
          },
        ];
      },
    );
    return [hostHelperGate, hostJobControlGate, ...behaviorGates];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function requestFixture(url) {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { timeout: 3_000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () =>
        resolve({
          statusCode: response.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    request.once("timeout", () =>
      request.destroy(new Error("request timed out")),
    );
    request.once("error", reject);
  });
}

function wasProxyDenied(outcome) {
  return (
    outcome.response?.ok === true &&
    outcome.response.result.exitCode === 22 &&
    /returned error: 403/.test(outcome.response.result.stderr)
  );
}

function proxyAuthorization(credentials) {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
}

function requestProxyStatus(proxyPort, url, credentials) {
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
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
  });
}

function runCurlThroughProxy(proxyPort, url, credentials) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/curl",
      [
        "--proxy",
        `http://127.0.0.1:${proxyPort}`,
        ...(credentials
          ? ["--proxy-user", `${credentials.username}:${credentials.password}`]
          : []),
        "--proxytunnel",
        "--noproxy",
        "",
        "--location",
        "--fail",
        "--silent",
        "--show-error",
        url,
      ],
      { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode, signal) =>
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

async function probeNetworkBehavior() {
  let privateHits = 0;
  let redirectHits = 0;
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      redirectHits += 1;
      response.writeHead(302, {
        Location: `http://127.0.0.1:${server.address().port}/private`,
      });
      response.end();
      return;
    }
    if (request.url === "/private") {
      privateHits += 1;
    }
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("fixture-ok");
  });
  const port = await listen(server);
  const root = await makeSandboxRoot("network");
  const fixtureHost = hostname();
  try {
    const resolvedAddresses = await lookup(fixtureHost, { all: true });
    const baselineHitsBefore = privateHits;
    let baseline;
    try {
      baseline = await requestFixture(`http://${fixtureHost}:${port}/private`);
    } catch (error) {
      baseline = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const baselinePrivateHits = privateHits - baselineHitsBefore;
    const baselineReachedFixture =
      baseline.statusCode === 200 &&
      baseline.body === "fixture-ok" &&
      baselinePrivateHits === 1;
    const curl = (url, options = "") =>
      `/usr/bin/curl --noproxy '' --fail --silent --show-error ${options} ${shellQuote(url)}`;
    const hitsBeforeAllowedPrivate = privateHits;
    const allowedPrivateResolution = await runHelper(
      makeRequest(root, {
        command: curl(`http://${fixtureHost}:${port}/private`),
        network: { allowedDomains: [fixtureHost] },
      }),
    );
    const allowedPrivateHits = privateHits - hitsBeforeAllowedPrivate;
    const directPrivate = await runHelper(
      makeRequest(root, {
        command: curl(`http://127.0.0.1:${port}/private`),
      }),
    );
    const redirectHost = "redirect.public.example";
    const redirectApprovedAddress = "93.184.216.34";
    const redirectDials = [];
    const redirectProxy = await startTrustedNetworkProxies(
      [redirectHost],
      {
        lookupAll: async (host) => {
          if (host !== redirectHost) {
            throw new Error(`unexpected redirect test lookup: ${host}`);
          }
          return [{ address: redirectApprovedAddress, family: 4 }];
        },
      },
      {
        dial: async (approved, destinationPort) => {
          redirectDials.push({ approved, destinationPort });
          return createConnection(destinationPort, "127.0.0.1");
        },
      },
    );
    const hitsBeforeRedirect = privateHits;
    const redirectHitsBefore = redirectHits;
    let redirect;
    try {
      redirect = await runCurlThroughProxy(
        redirectProxy.httpPort,
        `http://${redirectHost}:${port}/redirect`,
        redirectProxy.credentials,
      );
    } finally {
      await redirectProxy.close();
    }
    const redirectPrivateHits = privateHits - hitsBeforeRedirect;
    const redirectFirstHopHits = redirectHits - redirectHitsBefore;
    const explicitPrivate = await runHelper(
      makeRequest(root, {
        command: curl(`http://127.0.0.1:${port}/private`),
        network: { allowedDomains: ["127.0.0.1"] },
      }),
    );
    let authenticationPolicyEvaluations = 0;
    let authenticationDials = 0;
    const authenticationResolver = {
      lookupAll: async () => {
        authenticationPolicyEvaluations += 1;
        return [{ address: "93.184.216.34", family: 4 }];
      },
    };
    const authenticationDial = {
      dial: async () => {
        authenticationDials += 1;
        throw new Error("authentication must precede dialing");
      },
    };
    const firstSession = await startTrustedNetworkProxies(
      ["auth.public.example"],
      authenticationResolver,
      authenticationDial,
    );
    const secondSession = await startTrustedNetworkProxies(
      ["auth.public.example"],
      authenticationResolver,
      authenticationDial,
    );
    let unauthenticated;
    let crossSession;
    try {
      unauthenticated = await requestProxyStatus(
        firstSession.httpPort,
        "http://auth.public.example/",
      );
      crossSession = await requestProxyStatus(
        firstSession.httpPort,
        "http://auth.public.example/",
        secondSession.credentials,
      );
    } finally {
      await Promise.all([firstSession.close(), secondSession.close()]);
    }

    return [
      {
        gate: "network-allowlisted-host-private-resolution-denied",
        passed:
          baselineReachedFixture &&
          resolvedAddresses.length > 0 &&
          wasProxyDenied(allowedPrivateResolution) &&
          allowedPrivateHits === 0,
        evidence: {
          fixtureHost,
          resolvedAddresses,
          baseline,
          baselinePrivateHits,
          baselineReachedFixture,
          outcome: allowedPrivateResolution,
          allowedPrivateHits,
        },
        limitation:
          "Filtering only the requested hostname is insufficient; the resolved destination must also be checked against local/private ranges.",
      },
      {
        gate: "network-private-ip-default-deny",
        passed: wasProxyDenied(directPrivate),
        evidence: directPrivate,
      },
      {
        gate: "network-redirect-revalidation",
        passed:
          redirectFirstHopHits === 1 &&
          redirect.exitCode !== 0 &&
          /403/.test(redirect.stderr) &&
          redirectPrivateHits === 0 &&
          redirectDials.length === 1 &&
          redirectDials[0].approved.address === redirectApprovedAddress &&
          redirectDials[0].destinationPort === port,
        evidence: {
          outcome: redirect,
          redirectHost,
          redirectApprovedAddress,
          redirectDials,
          redirectFirstHopHits,
          redirectPrivateHits,
        },
        limitation:
          "The allowlisted first hop uses the adapter's injected test dial to reach a local fixture after public-address approval; the followed private-literal CONNECT uses the production policy and is denied before dialing.",
      },
      {
        gate: "network-proxy-authentication-session-binding",
        passed:
          firstSession.sessionId !== secondSession.sessionId &&
          firstSession.credentials.password !==
            secondSession.credentials.password &&
          unauthenticated === 407 &&
          crossSession === 407 &&
          authenticationPolicyEvaluations === 0 &&
          authenticationDials === 0,
        evidence: {
          sessionsDistinct: firstSession.sessionId !== secondSession.sessionId,
          credentialsDistinct:
            firstSession.credentials.password !==
            secondSession.credentials.password,
          unauthenticatedStatus: unauthenticated,
          crossSessionStatus: crossSession,
          authenticationPolicyEvaluations,
          authenticationDials,
        },
        limitation:
          "The per-listener credential prevents other sandbox sessions and accidental local clients from borrowing a live policy. A trusted same-user host process can inspect or control child processes and remains outside this boundary.",
      },
      {
        gate: "network-private-ip-deny-precedes-allowlist",
        passed: wasProxyDenied(explicitPrivate),
        evidence: explicitPrivate,
        limitation:
          "A domain allowlist must not authorize loopback/private literals for the baseline policy.",
      },
    ];
  } finally {
    await closeServer(server);
    await rm(root, { recursive: true, force: true });
  }
}

function directChildPid(parentPid) {
  const outcome = spawnSync("/usr/bin/pgrep", ["-P", String(parentPid)], {
    encoding: "utf8",
    timeout: 2_000,
  });
  const pid = Number(outcome.stdout.trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function processGroupId(pid) {
  const outcome = spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2_000,
  });
  const pgid = Number(outcome.stdout.trim());
  return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
}

function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessGroupExit(pgid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pgid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processGroupExists(pgid);
}

async function waitForDirectChild(parentPid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = directChildPid(parentPid);
    if (pid) {
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

async function launchLongRunningHelper(root, marker) {
  const child = spawn(process.execPath, [HELPER_PATH], {
    cwd: REPO_ROOT,
    env: process.env,
    shell: false,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end(
    JSON.stringify(
      makeRequest(root, {
        command: `printf launched > ${shellQuote(marker)}; while :; do sleep 1; done`,
        timeoutMs: 60_000,
      }),
    ),
  );
  try {
    await waitForPath(marker);
    const reaperPid = await waitForDirectChild(child.pid);
    if (!reaperPid) {
      throw new Error("could not identify the helper's direct reaper child");
    }
    const sandboxPid = await waitForDirectChild(reaperPid);
    if (!sandboxPid) {
      throw new Error("could not identify the reaper's direct sandbox child");
    }
    const sandboxPgid = processGroupId(sandboxPid);
    if (!sandboxPgid || sandboxPgid !== sandboxPid) {
      throw new Error(
        `sandbox child is not the expected detached process-group leader: pid=${sandboxPid} pgid=${sandboxPgid}`,
      );
    }
    return { helper: child, reaperPid, sandboxPid, sandboxPgid };
  } catch (error) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
    throw error;
  }
}

async function probeParentDeathBehavior() {
  const root = await makeSandboxRoot("parent-death");
  const results = [];
  try {
    const graceful = await launchLongRunningHelper(
      root,
      path.join(root, "graceful-launched"),
    );
    graceful.helper.kill("SIGTERM");
    const gracefulExited = await waitForProcessGroupExit(graceful.sandboxPgid);
    if (!gracefulExited) {
      try {
        process.kill(-graceful.sandboxPgid, "SIGKILL");
      } catch {}
    }
    results.push({
      gate: "supervisor-graceful-death-cleanup",
      passed: gracefulExited,
      evidence: {
        reaperPid: graceful.reaperPid,
        sandboxPid: graceful.sandboxPid,
        sandboxPgid: graceful.sandboxPgid,
        processGroupExited: gracefulExited,
      },
    });

    const abrupt = await launchLongRunningHelper(
      root,
      path.join(root, "abrupt-launched"),
    );
    abrupt.helper.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const abruptExited = await waitForProcessGroupExit(
      abrupt.sandboxPgid,
      1_000,
    );
    if (!abruptExited) {
      try {
        process.kill(-abrupt.sandboxPgid, "SIGKILL");
      } catch {}
      await waitForProcessGroupExit(abrupt.sandboxPgid);
    }
    results.push({
      gate: "supervisor-abrupt-parent-death-cleanup",
      passed: abruptExited,
      evidence: {
        reaperPid: abrupt.reaperPid,
        sandboxPid: abrupt.sandboxPid,
        sandboxPgid: abrupt.sandboxPgid,
        processGroupExited: abruptExited,
      },
      limitation:
        "This proves helper-SIGKILL cleanup through an independent sibling reaper on this Darwin host; it is not a kernel subreaper or VM/container boundary.",
    });
    return results;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runGateGroup(name, operation) {
  const startedAt = performance.now();
  try {
    const gates = await operation();
    return { name, durationMs: performance.now() - startedAt, gates };
  } catch (error) {
    return {
      name,
      durationMs: performance.now() - startedAt,
      gates: [
        {
          gate: `${name}-probe-completed`,
          passed: false,
          error: error instanceof Error ? error.stack : String(error),
        },
      ],
    };
  }
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("macOS sandbox behavior gates require a local Darwin host");
  }
  const groups = [];
  groups.push(await runGateGroup("pty", probePtyBehavior));
  groups.push(await runGateGroup("network", probeNetworkBehavior));
  groups.push(await runGateGroup("parent-death", probeParentDeathBehavior));
  const gates = groups.flatMap((group) => group.gates);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    runtimeVersion: "0.0.65",
    strict,
    summary: {
      total: gates.length,
      passed: gates.filter((gate) => gate.passed).length,
      failed: gates.filter((gate) => !gate.passed).length,
      p95GroupDurationMs: percentile(
        groups.map((group) => group.durationMs),
        0.95,
      ),
    },
    groups,
  };
  if (!jsonOnly) {
    for (const gate of gates) {
      process.stderr.write(`${gate.passed ? "PASS" : "FAIL"} ${gate.gate}\n`);
    }
    process.stderr.write(
      `Collected ${report.summary.total} gates: ${report.summary.passed} passed, ${report.summary.failed} failed.\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (strict && report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

await main();
