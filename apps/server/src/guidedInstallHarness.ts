// Shared harness for the guided installer tests. The scenarios run the real
// installer in synchronous shell subprocesses, so they are split across
// several `guidedInstall*.test.ts` files that Vitest can run in parallel.
import { afterEach, expect } from "vitest";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

export const installer = resolve("deploy/install.sh");
export const upgrade = resolve("deploy/upgrade.sh");
export const container = resolve("deploy/container");
const roots: string[] = [];

/** Removes each test's fixture folders after it finishes. */
export function cleanUpInstallFixtures(): void {
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
  });
}

export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "assistant-install-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  const assets = join(root, "assets");
  mkdirSync(bin);
  mkdirSync(assets);
  const deploy = join(root, "assistant");
  const log = join(root, "commands");
  const version = "1.2.3";
  const manifest =
    [
      `RELEASE_VERSION=${version}`,
      `RELEASE_COMMIT=${"a".repeat(40)}`,
      ...[
        "assistant",
        "command-worker",
        "publisher",
        "backup",
        "editor",
        "browser",
        "updater",
      ].map(
        (target) =>
          `${target.toUpperCase().replaceAll("-", "_")}_IMAGE=ghcr.io/reefbarman/agentlink-${target}@sha256:${"b".repeat(64)}`,
      ),
    ].join("\n") + "\n";
  writeFileSync(join(assets, "assistant-release.env"), manifest);
  copyFileSync(upgrade, join(assets, "upgrade.sh"));
  copyFileSync(installer, join(assets, "install.sh"));
  const releaseAssets = [
    "compose.yaml",
    "compose.update-client.yaml",
    "compose.updater.yaml",
    "compose.publisher.yaml",
    "compose.runners.yaml",
    "compose.backup.yaml",
    "compose.editor.yaml",
    "compose.browser.yaml",
    "server.example.json",
  ];
  for (const name of releaseAssets)
    copyFileSync(join(container, name), join(assets, name));
  copyFileSync(
    join(container, "witness/compose.yaml"),
    join(assets, "compose.witness.yaml"),
  );
  const deploymentMetadata = {
    schemaVersion: 1,
    updaterProtocol: 1,
    lifecycleProtocol: 1,
    version,
    commit: "a".repeat(40),
    ...Object.fromEntries(
      [
        "install.sh",
        "upgrade.sh",
        "compose.witness.yaml",
        ...releaseAssets,
      ].map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(join(assets, name)))
          .digest("hex"),
      ]),
    ),
  };
  writeFileSync(
    join(assets, "assistant-deployment.json"),
    `${JSON.stringify(deploymentMetadata, null, 2)}\n`,
  );
  const mock = `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path');
const tool=path.basename(process.argv[1]), args=process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG,JSON.stringify({tool,args,cwd:process.cwd()})+'\\n');
if(tool==='id'){ console.log('1000'); }
else if(tool==='uname'){ console.log(args[0]==='-s' ? (process.env.TEST_OS||'Linux') : 'arm64'); }
else if(tool==='docker'){
 if(args[0]==='image' && args[1]==='inspect') process.exit(process.env.TEST_EXISTING_IMAGES ? 0 : 1);
 if(args[0]==='ps' && process.env.TEST_EXISTING_CONTAINERS) console.log('existing-container');
 if(args[0]==='ps' && process.env.TEST_CHILDREN && args.includes('--format')){
  const label=args.find(a=>a.startsWith('label=dev.agentlink.'));
  if(label){
   const kind=label.slice('label=dev.agentlink.'.length);
   // One container the runner manager started, and an unrelated one that only shares the label.
   console.log('c0ffee00c0ff agentlink-'+kind+'-t1 t1');
   console.log('badd00dbadd0 someone-elses-'+kind+' t1');
  }
 }
 if(args[0]==='version') console.log(process.env.TEST_DOCKER_VERSION||'28.1.0');
 if(args[0]==='context' && args[1]==='inspect') console.log(process.env.TEST_DOCKER_ENDPOINT||'unix:///var/run/docker.sock');
 if(args[0]==='info' && args.includes('--format')){
  const format=args[args.indexOf('--format')+1];
  if(format.includes('OperatingSystem')) console.log(process.env.TEST_DOCKER_OS||(process.env.TEST_OS==='Darwin'?'Docker Desktop':'Ubuntu 24.04 LTS'));
  if(format.includes('Architecture')) console.log(process.env.TEST_DOCKER_ARCH||'aarch64');
  if(format.includes('SecurityOptions')) console.log(process.env.TEST_DOCKER_SECURITY||'[name=seccomp,profile=builtin]');
 }
 if(process.env.TEST_DOCKER_FAIL && args.includes(process.env.TEST_DOCKER_FAIL) && (!process.env.TEST_DOCKER_FAIL_DIR || process.cwd().endsWith(process.env.TEST_DOCKER_FAIL_DIR))) process.exit(1);
 if(args.includes('export-ca')) console.log('PUBLIC CERTIFICATE');
 if(args.includes('backup')) console.log('Backup abcdef12 done.');
}
else if(tool==='curl'){
 const url=args.find(x=>x.startsWith('https://')), name=url.split('/').pop();
 fs.copyFileSync(path.join(process.env.TEST_ASSETS,name),args[args.indexOf('--output')+1]);
}
else if(tool==='ss' || tool==='lsof'){ if(process.env.TEST_PORT_BUSY) console.log('LISTEN 0 4096 0.0.0.0:8443'); }
else if(tool==='getent'){ if(process.env.TEST_UNRESOLVED) process.exit(2); console.log('192.0.2.10 assistant.local'); }
else if(tool==='dscacheutil'){ if(!process.env.TEST_UNRESOLVED) console.log('ip_address: 192.0.2.10'); }
`;
  for (const name of [
    "id",
    "uname",
    "docker",
    "curl",
    "ss",
    "lsof",
    "getent",
    "dscacheutil",
  ]) {
    const file = join(bin, name);
    writeFileSync(file, mock);
    chmodSync(file, 0o755);
  }
  const run = (args: string[], extra: Record<string, string> = {}) =>
    // AGENTLINK_TEST_BASH=/bin/bash exercises macOS's Bash 3.2.
    spawnSync(
      process.env.AGENTLINK_TEST_BASH ?? "bash",
      [installer, ...args, "--deploy", deploy],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TEST_LOG: log,
          TEST_ASSETS: assets,
          HOME: root,
          // The host's own Docker selection must not leak into the fixture.
          DOCKER_HOST: "",
          ...extra,
        },
      },
    );
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as { tool: string; args: string[]; cwd: string },
          )
      : [];
  const install = (extra: Record<string, string> = {}) =>
    run(
      [
        "install",
        "--version",
        version,
        "--origin",
        "https://assistant.local:8443",
        "--yes",
      ],
      extra,
    );
  return { root, assets, deploy, log, version, run, install, calls };
}

/** Nothing downloaded, pulled, tagged, started or written. */
export function expectUntouched(f: ReturnType<typeof fixture>) {
  expect(f.calls().some((call) => call.tool === "curl")).toBe(false);
  expect(
    f
      .calls()
      .some(
        (call) =>
          call.tool === "docker" &&
          ["pull", "tag", "run", "create"].includes(call.args[0]!),
      ),
  ).toBe(false);
  expect(
    f
      .calls()
      .some(
        (call) =>
          call.tool === "docker" &&
          call.args[0] === "compose" &&
          call.args[1] !== "version",
      ),
  ).toBe(false);
  expect(existsSync(f.deploy)).toBe(false);
  expect(existsSync(`${f.deploy}-witness`)).toBe(false);
  expect(existsSync(`${f.deploy}-updater`)).toBe(false);
  expect(existsSync(join(f.root, ".agentlink-assistant-install.lock"))).toBe(
    false,
  );
}

/** A finished fresh installation, with the command log cleared. */
export function installed() {
  const f = fixture();
  const result = f.install();
  expect(result.status).toBe(0);
  rmSync(f.log, { force: true });
  const updater = `${f.deploy}-updater`;
  const read = (name: string) => readFileSync(join(f.deploy, name), "utf8");
  const journal = () =>
    JSON.parse(readFileSync(join(updater, ".lifecycle-state.json"), "utf8"));
  const lock = join(updater, ".deployment-mutation-lock");
  const dockerCalls = () => f.calls().filter((call) => call.tool === "docker");
  const compose = (...args: string[]) =>
    dockerCalls().filter(
      (call) =>
        call.args[0] === "compose" &&
        args.every((arg, index) => call.args[index + 1] === arg),
    );
  return { ...f, updater, read, journal, lock, dockerCalls, compose };
}

export const image = (target: string) =>
  `ghcr.io/reefbarman/agentlink-${target}@sha256:${"b".repeat(64)}`;
