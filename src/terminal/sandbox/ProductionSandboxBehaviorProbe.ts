import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { CURRENT_SANDBOX_POLICY_VERSION } from "../../core/sandboxPolicy.js";
import { BaselineSandboxLaunchAuthorizer } from "./BaselineSandboxLaunchAuthorizer.js";
import {
  SANDBOX_INTERACTIVE_HELPER_RELATIVE_PATH,
  createNodeSandboxHelperTransportFactory,
} from "./NodeSandboxHelperTransport.js";
import {
  type SandboxBehaviorProbeAdapter,
  type SandboxBehaviorProbeRequest,
  type SandboxBehaviorRuntimeFingerprint,
  type SandboxBehaviorSyntheticCheckResult,
} from "./SandboxBehaviorAttestationService.js";
import { SandboxHelperClient } from "./SandboxHelperClient.js";
import { SANDBOX_HELPER_PROTOCOL_VERSION } from "./sandboxHelperProtocol.js";
import type {
  SandboxCommandEvent,
  SandboxCommandProcess,
  SandboxCommandReady,
} from "./SandboxRuntimeProvider.js";

const PROFILE_ID = "workspace-write";
const MARKER = "AL_SANDBOX_ATTESTATION:";
const PRIVATE_PREFIX = "/tmp/al-attest-private-";

export interface ProductionSandboxBehaviorProbeOptions {
  extensionRoot: string;
  nodeExecutable: string;
  homeDirectory?: string;
}

export interface ProductionSandboxFingerprintOptions {
  extensionRoot: string;
  extensionVersion: string;
  nodeExecutable: string;
  architecture?: string;
  platform?: NodeJS.Platform;
}

interface ProbeFixtures {
  root: string;
  workspace: string;
  outsideFile: string;
  credentialFile: string;
  gitFile: string;
  policyFile: string;
  agentsFile: string;
  codexFile: string;
  instructionsFile: string;
  symlinkPath: string;
  nonexistentProtectedPath: string;
  scriptPath: string;
}

interface CommandEvidence {
  ready: SandboxCommandReady;
  output: string;
  events: SandboxCommandEvent[];
  exitCode?: number;
  signal?: number;
  pgidCleaned: boolean;
}

interface ScriptEvidence {
  workspaceCreateAllowed: boolean;
  workspaceModifyAllowed: boolean;
  outsideReadAllowed: boolean;
  outsideWriteDenied: boolean;
  gitWriteDenied: boolean;
  policyWriteDenied: boolean;
  agentsWriteDenied: boolean;
  codexWriteDenied: boolean;
  instructionsWriteDenied: boolean;
  symlinkWriteDenied: boolean;
  nonexistentDescendantWriteDenied: boolean;
  childOutsideReadAllowed: boolean;
  grandchildProtectedAccessDenied: boolean;
  homeMatchesHost: boolean;
  hostHomeReadAllowed: boolean;
  hostHomeWriteDenied: boolean;
  hostTmpEnvironmentMatched: boolean;
  hostTmpWriteAllowed: boolean;
  slashTmpWriteAllowed: boolean;
  cacheIsPrivate: boolean;
  credentialEnvironmentInherited: boolean;
  baselineIpv4LoopbackConnectAllowed: boolean;
  baselineIpv6LoopbackConnectAllowedOrUnavailable: boolean;
  baselineListenerBindDenied: boolean;
  privateConnectDenied: boolean;
  publicConnectDenied: boolean;
  proxyEndpointsLoopbackOnly: boolean;
}

interface ListenerCapabilityEvidence {
  listenerCapabilityBindAllowed: boolean;
  listenerCapabilityPrivateConnectDenied: boolean;
  listenerCapabilityPublicConnectDenied: boolean;
}

const PROBE_SCRIPT = String.raw`
  const fs = require("node:fs");
  const net = require("node:net");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
const MARKER = ${JSON.stringify(MARKER)};

function denied(operation) {
  try { operation(); return false; } catch { return true; }
}

function connectAllowed(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(700, () => finish(false));
  });
}

function policyDenied(error) {
  return error && (error.code === "EPERM" || error.code === "EACCES");
}

function connectPolicyDenied(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", (error) => finish(policyDenied(error)));
    socket.setTimeout(700, () => finish(false));
  });
}

function bindAllowed(host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      server.close(() => resolve(value));
    };
    server.once("error", () => finish(false));
    server.listen(0, host, () => finish(true));
  });
}

function bindPolicyDenied(host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (server.listening) server.close(() => resolve(value));
      else resolve(value);
    };
    server.once("error", (error) => finish(policyDenied(error)));
    server.listen(0, host, () => finish(false));
  });
}

function proxyEndpointsLoopbackOnly() {
  const names = [
    "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
    "ALL_PROXY", "all_proxy",
  ];
  const values = names.map((name) => process.env[name]).filter(Boolean);
  if (values.length === 0) return false;
  return values.every((value) => {
    try {
      const host = new URL(value).hostname.toLowerCase();
      return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    } catch {
      return false;
    }
  });
}

const mode = process.argv[2];
const outsideFile = process.argv[3];
const protectedFile = process.argv[4];
if (mode === "grandchild") {
  process.stdout.write(JSON.stringify({ protectedDenied: denied(() => fs.writeFileSync(protectedFile, "bad")) }));
  process.exit(0);
}
if (mode === "child") {
  const grandchild = spawnSync(process.execPath, [__filename, "grandchild", outsideFile, protectedFile], { encoding: "utf8" });
  let parsed = {};
  try { parsed = JSON.parse(grandchild.stdout || "{}"); } catch {}
  process.stdout.write(JSON.stringify({
    outsideReadAllowed: !denied(() => fs.readFileSync(outsideFile)),
    grandchildProtectedDenied: parsed.protectedDenied === true,
  }));
  process.exit(0);
}

(async () => {
  if (mode === "listener-capability") {
    const evidence = {
      listenerCapabilityBindAllowed: await bindAllowed("127.0.0.1"),
      listenerCapabilityPrivateConnectDenied: await connectPolicyDenied("10.255.255.1", 9),
      listenerCapabilityPublicConnectDenied: await connectPolicyDenied("1.1.1.1", 53),
    };
    process.stdout.write(MARKER + JSON.stringify(evidence) + "\n");
    return;
  }
  const [workspace, credentialFile, gitFile, policyFile, agentsFile, codexFile, instructionsFile, symlinkPath, nonexistentProtectedPath, ipv4PortText, ipv6PortText, sentinelName, realHome, privateDirectoryPrefix, hostTemporaryDirectory] = process.argv.slice(4);
  const created = path.join(workspace, "created.txt");
  const modified = path.join(workspace, "modified.txt");
  fs.writeFileSync(created, "created");
  fs.writeFileSync(modified, "before");
  fs.writeFileSync(modified, "after");
  const child = spawnSync(process.execPath, [__filename, "child", outsideFile, gitFile], { encoding: "utf8" });
  let childEvidence = {};
  try { childEvidence = JSON.parse(child.stdout || "{}"); } catch {}
  const privateCacheRoot = path.dirname(process.env.XDG_CACHE_HOME || "");
  const privateCacheRootIsExpected = privateCacheRoot.startsWith(privateDirectoryPrefix);
  const evidence = {
    workspaceCreateAllowed: fs.readFileSync(created, "utf8") === "created",
    workspaceModifyAllowed: fs.readFileSync(modified, "utf8") === "after",
    outsideReadAllowed: !denied(() => fs.readFileSync(outsideFile)),
    outsideWriteDenied: denied(() => fs.writeFileSync(outsideFile, "bad")),
    gitWriteDenied: denied(() => fs.writeFileSync(gitFile, "bad")),
    policyWriteDenied: denied(() => fs.writeFileSync(policyFile, "bad")),
    agentsWriteDenied: denied(() => fs.writeFileSync(agentsFile, "bad")),
    codexWriteDenied: denied(() => fs.writeFileSync(codexFile, "bad")),
    instructionsWriteDenied: denied(() => fs.writeFileSync(instructionsFile, "bad")),
    symlinkWriteDenied: denied(() => fs.writeFileSync(symlinkPath, "bad")),
    nonexistentDescendantWriteDenied: denied(() => fs.writeFileSync(nonexistentProtectedPath, "bad")),
    childOutsideReadAllowed: childEvidence.outsideReadAllowed === true,
    grandchildProtectedAccessDenied: childEvidence.grandchildProtectedDenied === true,
    homeMatchesHost: process.env.HOME === realHome,
    hostHomeReadAllowed: !denied(() => fs.readFileSync(credentialFile)),
    hostHomeWriteDenied: denied(() => fs.writeFileSync(credentialFile, "bad")),
    hostTmpEnvironmentMatched: process.env.TMPDIR === hostTemporaryDirectory,
    hostTmpWriteAllowed: !denied(() => {
      const probe = path.join(process.env.TMPDIR, "agentlink-attest-" + process.pid);
      fs.writeFileSync(probe, "tmp");
      fs.unlinkSync(probe);
    }),
    slashTmpWriteAllowed: !denied(() => {
      const probe = path.join("/tmp", "agentlink-attest-" + process.pid);
      fs.writeFileSync(probe, "tmp");
      fs.unlinkSync(probe);
    }),
    cacheIsPrivate: privateCacheRootIsExpected && process.env.XDG_CACHE_HOME === path.join(privateCacheRoot, "c"),
    credentialEnvironmentInherited: process.env[sentinelName] === "host-secret-sentinel",
    baselineIpv4LoopbackConnectAllowed: await connectAllowed("127.0.0.1", Number(ipv4PortText)),
    baselineIpv6LoopbackConnectAllowedOrUnavailable:
      ipv6PortText === "unavailable" || await connectAllowed("::1", Number(ipv6PortText)),
    baselineListenerBindDenied: await bindPolicyDenied("127.0.0.1"),
    privateConnectDenied: await connectPolicyDenied("10.255.255.1", 9),
    publicConnectDenied: await connectPolicyDenied("1.1.1.1", 53),
    proxyEndpointsLoopbackOnly: proxyEndpointsLoopbackOnly(),
  };
  process.stdout.write(MARKER + JSON.stringify(evidence) + "\n");
})().catch((error) => {
  process.stderr.write(String(error && error.stack || error));
  process.exit(2);
});
`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function createFixtures(): Promise<ProbeFixtures> {
  const root = await realpath(
    await mkdtemp(path.join(os.homedir(), ".agentlink-sandbox-attest-")),
  );
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const fakeHome = path.join(root, "real-home");
  await Promise.all([
    mkdir(path.join(workspace, ".git"), { recursive: true }),
    mkdir(path.join(workspace, ".agentlink"), { recursive: true }),
    mkdir(path.join(workspace, ".agents"), { recursive: true }),
    mkdir(path.join(workspace, ".codex"), { recursive: true }),
    mkdir(outside, { recursive: true }),
    mkdir(fakeHome, { recursive: true }),
  ]);
  const outsideFile = path.join(outside, "sentinel.txt");
  const credentialFile = path.join(fakeHome, ".credential-sentinel");
  const gitFile = path.join(workspace, ".git", "config");
  const policyFile = path.join(workspace, ".agentlink", "policy.md");
  const agentsFile = path.join(workspace, ".agents", "config.json");
  const codexFile = path.join(workspace, ".codex", "config.toml");
  const instructionsFile = path.join(workspace, "AGENTS.md");
  const symlinkPath = path.join(workspace, "outside-link");
  const nonexistentProtectedPath = path.join(
    workspace,
    ".agentlink",
    "future",
    "policy.md",
  );
  const scriptPath = path.join(workspace, "attestation.cjs");
  await Promise.all([
    writeFile(outsideFile, "outside-sentinel", { mode: 0o600 }),
    writeFile(credentialFile, "credential-sentinel", { mode: 0o600 }),
    writeFile(gitFile, "git-sentinel", { mode: 0o600 }),
    writeFile(policyFile, "policy-sentinel", { mode: 0o600 }),
    writeFile(agentsFile, "agents-sentinel", { mode: 0o600 }),
    writeFile(codexFile, "codex-sentinel", { mode: 0o600 }),
    writeFile(instructionsFile, "instructions-sentinel", { mode: 0o600 }),
    writeFile(scriptPath, PROBE_SCRIPT, { mode: 0o700 }),
    symlink(outsideFile, symlinkPath),
  ]);
  await chmod(root, 0o700);
  return {
    root,
    workspace,
    outsideFile,
    credentialFile,
    gitFile,
    policyFile,
    agentsFile,
    codexFile,
    instructionsFile,
    symlinkPath,
    nonexistentProtectedPath,
    scriptPath,
  };
}

async function listenLoopback(host: "127.0.0.1" | "::1"): Promise<{
  port: number;
  hits(): number;
  close(): Promise<void>;
}> {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Loopback fixture did not bind a TCP port");
  }
  return {
    port: address.port,
    hits: () => connections,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function processGroupCleaned(pgid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function runAuthorizedCommand(
  runtime: SandboxHelperClient,
  authorizer: BaselineSandboxLaunchAuthorizer,
  command: string,
  cwd: string,
  request: SandboxBehaviorProbeRequest,
  commandLabel: string,
  allowLocalBinding = false,
): Promise<CommandEvidence> {
  const channelId = `attest-${randomUUID()}`;
  const commandId = `attest-${commandLabel}-${randomUUID()}`;
  const generation = 1;
  const authorized = await authorizer.authorize({
    options: {
      owner: undefined,
      command,
      cwd,
      sandboxSessionId: "sandbox-behavior-attestation",
      ...(allowLocalBinding
        ? { sandboxCapabilityRequest: { allowLocalBinding: true } }
        : {}),
    },
    channelId,
    commandId,
    generation,
    dimensions: { columns: 100, rows: 30 },
  });
  let commandProcess: SandboxCommandProcess | undefined;
  request.registerCleanup(() => authorized.finalize?.());
  request.registerCleanup(() => commandProcess?.dispose());
  commandProcess = runtime.launch(authorized.helperRequest);
  const events: SandboxCommandEvent[] = [];
  let output = "";
  const subscription = commandProcess.onEvent((event) => {
    events.push(event);
    if (event.type === "data") {
      output += event.data;
      request.recordOutput(event.data);
    }
  });
  request.registerCleanup(() => subscription.dispose());
  const abort = () => commandProcess?.terminate();
  request.signal.addEventListener("abort", abort, { once: true });
  request.registerCleanup(() =>
    request.signal.removeEventListener("abort", abort),
  );
  const ready = await commandProcess.ready;
  const exit = await commandProcess.completion;
  subscription.dispose();
  authorized.finalize?.();
  return {
    ready,
    output,
    events,
    exitCode: exit.exitCode,
    signal: exit.signal,
    pgidCleaned: await processGroupCleaned(ready.pgid),
  };
}

function parseScriptEvidence<T>(output: string): T | undefined {
  const marker = output.lastIndexOf(MARKER);
  if (marker < 0) return undefined;
  const line = output
    .slice(marker + MARKER.length)
    .split(/\r?\n/, 1)[0]
    ?.trim();
  if (!line) return undefined;
  try {
    return JSON.parse(line) as T;
  } catch {
    return undefined;
  }
}

export function createProductionSandboxBehaviorProbe(
  options: ProductionSandboxBehaviorProbeOptions,
): SandboxBehaviorProbeAdapter {
  return {
    async run(request) {
      const fixtures = await createFixtures();
      request.registerCleanup(() =>
        rm(fixtures.root, { recursive: true, force: true }),
      );
      const ipv4Listener = await listenLoopback("127.0.0.1");
      request.registerCleanup(() => ipv4Listener.close());
      let ipv6Listener: Awaited<ReturnType<typeof listenLoopback>> | undefined;
      try {
        ipv6Listener = await listenLoopback("::1");
        request.registerCleanup(() => ipv6Listener?.close());
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EADDRNOTAVAIL" && code !== "EAFNOSUPPORT") throw error;
      }
      const runtime = new SandboxHelperClient(
        createNodeSandboxHelperTransportFactory({
          extensionRoot: options.extensionRoot,
          nodeExecutable: options.nodeExecutable,
        }),
      );
      request.registerCleanup(() => runtime.dispose());
      const sentinelName = `AL_ATTEST_HOST_${randomUUID().replaceAll("-", "")}`;
      const authorizer = new BaselineSandboxLaunchAuthorizer({
        workspaceRoots: [fixtures.workspace],
        homeDirectory:
          options.homeDirectory ?? path.dirname(fixtures.credentialFile),
        privateDirectoryPrefix: PRIVATE_PREFIX,
        trustedRuntimeRoots: [path.dirname(options.nodeExecutable)],
        hostEnvironment: {
          ...process.env,
          [sentinelName]: "host-secret-sentinel",
        },
      });
      const privateDirectoryPrefix = path.join(
        await realpath(path.dirname(PRIVATE_PREFIX)),
        path.basename(PRIVATE_PREFIX),
      );

      const command = [
        options.nodeExecutable,
        fixtures.scriptPath,
        "parent",
        fixtures.outsideFile,
        fixtures.workspace,
        fixtures.credentialFile,
        fixtures.gitFile,
        fixtures.policyFile,
        fixtures.agentsFile,
        fixtures.codexFile,
        fixtures.instructionsFile,
        fixtures.symlinkPath,
        fixtures.nonexistentProtectedPath,
        String(ipv4Listener.port),
        ipv6Listener ? String(ipv6Listener.port) : "unavailable",
        sentinelName,
        options.homeDirectory ?? path.dirname(fixtures.credentialFile),
        privateDirectoryPrefix,
        await realpath(os.tmpdir()),
      ]
        .map(shellQuote)
        .join(" ");
      const conformance = await runAuthorizedCommand(
        runtime,
        authorizer,
        command,
        fixtures.workspace,
        request,
        "conformance",
      );
      const evidence = parseScriptEvidence<ScriptEvidence>(conformance.output);
      if (!evidence) {
        return { outcome: "failed", failureCode: "helper_protocol_failed" };
      }
      const listenerCommand = [
        options.nodeExecutable,
        fixtures.scriptPath,
        "listener-capability",
      ]
        .map(shellQuote)
        .join(" ");
      const listenerCapability = await runAuthorizedCommand(
        runtime,
        authorizer,
        listenerCommand,
        fixtures.workspace,
        request,
        "listener-capability",
        true,
      );
      const listenerEvidence = parseScriptEvidence<ListenerCapabilityEvidence>(
        listenerCapability.output,
      );
      if (!listenerEvidence) {
        return { outcome: "failed", failureCode: "helper_protocol_failed" };
      }
      const interrupt = await runInterruptProbe(
        runtime,
        authorizer,
        options.nodeExecutable,
        fixtures.workspace,
        request,
      );
      const violations = conformance.events.filter(
        (event) => event.type === "violation",
      );
      const checks: SandboxBehaviorSyntheticCheckResult = {
        helperLifecycle: {
          productionHelperLaunched: conformance.ready.backend === "seatbelt",
          protocolIdentityMatched:
            conformance.ready.backend === "seatbelt" &&
            interrupt.ready.backend === "seatbelt",
          readyObserved: true,
          outputObserved: conformance.output.includes(MARKER),
          exitObserved: conformance.exitCode !== undefined,
          interruptCompleted:
            interrupt.exitCode === 130 && interrupt.signal === 2,
          helperCleanupCompleted:
            conformance.pgidCleaned &&
            listenerCapability.pgidCleaned &&
            interrupt.pgidCleaned,
        },
        workspaceConfinement: {
          workspaceCreateAllowed: evidence.workspaceCreateAllowed,
          workspaceModifyAllowed: evidence.workspaceModifyAllowed,
          outsideReadAllowed: evidence.outsideReadAllowed,
          outsideWriteDenied: evidence.outsideWriteDenied,
        },
        protectedMetadata: {
          gitWriteDenied: evidence.gitWriteDenied,
          policyWriteDenied:
            evidence.policyWriteDenied &&
            evidence.agentsWriteDenied &&
            evidence.codexWriteDenied &&
            evidence.instructionsWriteDenied,
          symlinkWriteDenied: evidence.symlinkWriteDenied,
          nonexistentDescendantWriteDenied:
            evidence.nonexistentDescendantWriteDenied,
        },
        processInheritance: {
          childOutsideReadAllowed: evidence.childOutsideReadAllowed,
          grandchildProtectedAccessDenied:
            evidence.grandchildProtectedAccessDenied,
          ownedProcessGroupCleaned:
            conformance.pgidCleaned &&
            listenerCapability.pgidCleaned &&
            interrupt.pgidCleaned,
        },
        privateEnvironment: {
          homeMatchesHost: evidence.homeMatchesHost,
          hostHomeReadAllowed: evidence.hostHomeReadAllowed,
          hostHomeWriteDenied: evidence.hostHomeWriteDenied,
          hostTmpEnvironmentMatched: evidence.hostTmpEnvironmentMatched,
          hostTmpWriteAllowed: evidence.hostTmpWriteAllowed,
          slashTmpWriteAllowed: evidence.slashTmpWriteAllowed,
          cacheIsPrivate: evidence.cacheIsPrivate,
          credentialEnvironmentInherited:
            evidence.credentialEnvironmentInherited,
        },
        networkConfinement: {
          baselineIpv4LoopbackConnectAllowed:
            evidence.baselineIpv4LoopbackConnectAllowed,
          baselineIpv6LoopbackConnectAllowedOrUnavailable:
            evidence.baselineIpv6LoopbackConnectAllowedOrUnavailable,
          baselineListenerBindDenied: evidence.baselineListenerBindDenied,
          privateConnectDenied: evidence.privateConnectDenied,
          publicConnectDenied: evidence.publicConnectDenied,
          listenerCapabilityBindAllowed:
            listenerEvidence.listenerCapabilityBindAllowed,
          listenerCapabilityPrivateConnectDenied:
            listenerEvidence.listenerCapabilityPrivateConnectDenied,
          listenerCapabilityPublicConnectDenied:
            listenerEvidence.listenerCapabilityPublicConnectDenied,
          loopbackFixtureReached:
            ipv4Listener.hits() > 0 &&
            (!ipv6Listener || ipv6Listener.hits() > 0),
          proxyEndpointsLoopbackOnly: evidence.proxyEndpointsLoopbackOnly,
        },
        denialEvidence: {
          expectedDenialsObserved:
            evidence.outsideReadAllowed &&
            evidence.outsideWriteDenied &&
            evidence.gitWriteDenied &&
            evidence.baselineListenerBindDenied &&
            evidence.privateConnectDenied &&
            evidence.publicConnectDenied &&
            listenerEvidence.listenerCapabilityPrivateConnectDenied &&
            listenerEvidence.listenerCapabilityPublicConnectDenied,
          evidenceBounded:
            Buffer.byteLength(conformance.output, "utf8") +
              Buffer.byteLength(listenerCapability.output, "utf8") <=
            256 * 1024,
          evidenceNormalized: violations.every(
            (event) =>
              event.type !== "violation" ||
              !event.violation.target ||
              !event.violation.target.includes(fixtures.root),
          ),
          successIndependentOfExitCode:
            conformance.exitCode === 0 &&
            listenerCapability.exitCode === 0 &&
            Object.values(evidence).every(Boolean) &&
            Object.values(listenerEvidence).every(Boolean),
        },
      };
      return { outcome: "checks", checks };
    },
  };
}

async function runInterruptProbe(
  runtime: SandboxHelperClient,
  authorizer: BaselineSandboxLaunchAuthorizer,
  nodeExecutable: string,
  cwd: string,
  request: SandboxBehaviorProbeRequest,
): Promise<CommandEvidence> {
  const channelId = `attest-${randomUUID()}`;
  const commandId = `attest-interrupt-${randomUUID()}`;
  const authorized = await authorizer.authorize({
    options: {
      owner: undefined,
      command: `${shellQuote(nodeExecutable)} -e ${shellQuote('process.stdout.write("interrupt-ready\\n"); setInterval(() => {}, 1000)')}`,
      cwd,
      sandboxSessionId: "sandbox-behavior-attestation",
    },
    channelId,
    commandId,
    generation: 1,
    dimensions: { columns: 100, rows: 30 },
  });
  let commandProcess: SandboxCommandProcess | undefined;
  request.registerCleanup(() => authorized.finalize?.());
  request.registerCleanup(() => commandProcess?.dispose());
  commandProcess = runtime.launch(authorized.helperRequest);
  let output = "";
  const events: SandboxCommandEvent[] = [];
  const subscription = commandProcess.onEvent((event) => {
    events.push(event);
    if (event.type === "data") {
      output += event.data;
      request.recordOutput(event.data);
    }
  });
  request.registerCleanup(() => subscription.dispose());
  const ready = await commandProcess.ready;
  const outputObserved = await waitForOutput(() => output, request.signal);
  if (!outputObserved || !commandProcess.interrupt()) {
    commandProcess.terminate();
  }
  const exit = await commandProcess.completion;
  subscription.dispose();
  authorized.finalize?.();
  return {
    ready,
    output,
    events,
    exitCode: exit.exitCode,
    signal: exit.signal,
    pgidCleaned: await processGroupCleaned(ready.pgid),
  };
}

async function waitForOutput(
  output: () => string,
  signal: AbortSignal,
): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (output().includes("interrupt-ready")) return true;
    if (signal.aborted) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function listNativeAssets(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory()) return listNativeAssets(candidate);
      return entry.isFile() && entry.name.endsWith(".node") ? [candidate] : [];
    }),
  );
  return nested.flat().sort((left, right) => left.localeCompare(right));
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

export async function createProductionSandboxRuntimeFingerprint(
  options: ProductionSandboxFingerprintOptions,
): Promise<SandboxBehaviorRuntimeFingerprint> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  if (
    platform !== "darwin" ||
    (architecture !== "arm64" && architecture !== "x64")
  ) {
    throw new Error(
      "Production sandbox attestation supports local macOS arm64/x64 only",
    );
  }
  const extensionRoot = await realpath(options.extensionRoot);
  const nodeExecutable = await realpath(options.nodeExecutable);
  const helperPath = path.join(
    extensionRoot,
    SANDBOX_INTERACTIVE_HELPER_RELATIVE_PATH,
  );
  const nodePtyRoot = path.join(
    extensionRoot,
    "dist",
    "sandbox-runtime",
    "node_modules",
    "node-pty",
  );
  const nodePtyPackage = path.join(nodePtyRoot, "package.json");
  const nativeAssets = await listNativeAssets(nodePtyRoot);
  if (nativeAssets.length === 0) {
    throw new Error("Packaged node-pty native assets are missing");
  }
  const [nodeIdentity, helperHash, nodePtyPackageHash, nodePtyPackageJson] =
    await Promise.all([
      stat(nodeExecutable),
      hashFile(helperPath),
      hashFile(nodePtyPackage),
      readFile(nodePtyPackage, "utf8"),
    ]);
  const nativeAssetHashes = await Promise.all(
    nativeAssets.map(async (asset) => ({
      path: path.relative(nodePtyRoot, asset),
      hash: await hashFile(asset),
    })),
  );
  const nodePtyVersion = (
    JSON.parse(nodePtyPackageJson) as { version?: string }
  ).version;
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        extensionVersion: options.extensionVersion,
        policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
        profileId: PROFILE_ID,
        helperProtocolVersion: SANDBOX_HELPER_PROTOCOL_VERSION,
        helperHash,
        nodePtyPackageHash,
        nodePtyVersion,
        nativeAssetHashes,
        nodeExecutable,
        nodeIdentity: {
          dev: nodeIdentity.dev,
          ino: nodeIdentity.ino,
          mode: nodeIdentity.mode,
          size: nodeIdentity.size,
          mtimeMs: nodeIdentity.mtimeMs,
        },
        platform,
        architecture,
      }),
    )
    .digest("hex");
  return {
    digest,
    metadata: {
      extensionVersion: options.extensionVersion,
      policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
      profileId: PROFILE_ID,
      helperProtocolVersion: SANDBOX_HELPER_PROTOCOL_VERSION,
      backend: "seatbelt",
      platform: "darwin",
      architecture,
    },
  };
}
