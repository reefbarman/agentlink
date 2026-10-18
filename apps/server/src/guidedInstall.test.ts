import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const installer = resolve("deploy/install.sh");
const upgrade = resolve("deploy/upgrade.sh");
const container = resolve("deploy/container");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
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
function expectUntouched(f: ReturnType<typeof fixture>) {
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

// Each scenario launches multiple real shell subprocesses for hash validation.
// Keep the test budget above the fixture's bounded installer process timeout.
describe("guided release installer", { timeout: 20_000 }, () => {
  it("explains prerequisites without making changes for help", () => {
    const f = fixture();
    const result = f.run(["help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("release installer preview");
    expect(f.calls()).toEqual([]);
    expect(existsSync(f.deploy)).toBe(false);
  });

  it("requires an explicit version and consent before creating an installation", () => {
    const f = fixture();
    expect(f.run(["install"]).stderr).toContain("--version X.Y.Z");
    const result = f.run([
      "install",
      "--version",
      f.version,
      "--origin",
      "https://assistant.local:8443",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("confirmation requires a terminal");
    expect(existsSync(f.deploy)).toBe(false);
    expect(
      f
        .calls()
        .some((call) => call.tool === "docker" && call.args[0] === "pull"),
    ).toBe(false);
  });

  it("refuses older Docker before downloads or local writes", () => {
    const f = fixture();
    const result = f.run(["install", "--version", f.version, "--yes"], {
      TEST_DOCKER_VERSION: "27.5.0",
    });
    expect(result.stderr).toContain("Docker Engine 28+");
    expect(f.calls().some((call) => call.tool === "curl")).toBe(false);
    expect(existsSync(f.deploy)).toBe(false);
  });

  it("rejects an existing deployment without overwriting its secrets", () => {
    const f = fixture();
    mkdirSync(f.deploy);
    writeFileSync(join(f.deploy, "keep"), "existing records");
    const result = f.run(["install", "--version", f.version, "--yes"]);
    expect(result.stderr).toContain("already exists");
    expect(readFileSync(join(f.deploy, "keep"), "utf8")).toBe(
      "existing records",
    );
    expect(existsSync(join(f.deploy, "server.json"))).toBe(false);
    expect(f.calls().some((call) => call.args[0] === "pull")).toBe(false);
  });

  it("does not replace another Compose deployment or local image tags", () => {
    const f = fixture();
    const args = [
      "install",
      "--version",
      f.version,
      "--origin",
      "https://assistant.local:8443",
      "--yes",
    ];
    const running = f.run(args, { TEST_EXISTING_CONTAINERS: "1" });
    expect(running.stderr).toContain("deployment already exists");
    const tagged = f.run(args, { TEST_EXISTING_IMAGES: "1" });
    expect(tagged.stderr).toContain("local Assistant images already exist");
    expect(existsSync(f.deploy)).toBe(false);
    expect(
      f
        .calls()
        .some((call) => call.args[0] === "pull" || call.args[0] === "tag"),
    ).toBe(false);
  });

  it("creates a standard private deployment from pinned images with no host build on macOS", () => {
    const f = fixture();
    const result = f.run(
      [
        "install",
        "--version",
        f.version,
        "--origin",
        "https://assistant.local:8443",
        "--yes",
      ],
      { TEST_OS: "Darwin" },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const config = JSON.parse(
      readFileSync(join(f.deploy, "server.json"), "utf8"),
    );
    expect(config.publicOrigins).toEqual(["https://assistant.local:8443"]);
    expect(config).toHaveProperty("runners.manager.host", "runner-manager");
    expect(config).toHaveProperty("backup.host", "backup");
    expect(
      statSync(join(f.deploy, "secrets/backup-password")).mode & 0o777,
    ).toBe(0o600);
    expect(statSync(join(f.deploy, "data")).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(f.deploy, "agentlink-ca.pem"), "utf8")).toContain(
      "PUBLIC CERTIFICATE",
    );
    expect(existsSync(`${f.deploy}-witness/compose.yaml`)).toBe(true);
    expect(existsSync(`${f.deploy}-updater/compose.yaml`)).toBe(true);
    const updaterEnv = readFileSync(`${f.deploy}-updater/.env`, "utf8");
    expect(updaterEnv).toContain(
      `UPDATER_IMAGE=ghcr.io/reefbarman/agentlink-updater@sha256:${"b".repeat(64)}`,
    );
    expect(updaterEnv).toContain(`AGENTLINK_DEPLOY_DIRECTORY='${f.deploy}'`);
    expect(updaterEnv).toContain(
      `AGENTLINK_UPDATER_DIRECTORY='${f.deploy}-updater'`,
    );
    expect(readFileSync(join(f.deploy, ".env"), "utf8")).toContain(
      "compose.update-client.yaml",
    );
    const updaterToken = readFileSync(
      join(f.deploy, "secrets/updater-token"),
      "utf8",
    );
    expect(updaterToken.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(`${f.deploy}-updater/updater-token`, "utf8")).toBe(
      updaterToken,
    );
    expect(config).toHaveProperty("updater.host", "updater");
    expect(config).toHaveProperty("updater.port", 7900);
    expect(config).toHaveProperty(
      "updater.token.file",
      "/run/secrets/updater-token",
    );
    expect(
      readFileSync(join(f.deploy, "compose.update-client.yaml"), "utf8"),
    ).not.toContain("/var/run/docker.sock");
    const docker = f.calls().filter((call) => call.tool === "docker");
    expect(docker.filter((call) => call.args[0] === "pull")).toHaveLength(6);
    const pulls = docker.filter((call) => call.args[0] === "pull");
    expect(
      pulls
        .filter((call) => call.args[1]!.startsWith("ghcr.io/"))
        .every((call) => call.args[1]!.includes("@sha256:")),
    ).toBe(true);
    // The witness is pulled before any state exists, like the GHCR images.
    expect(pulls.map((call) => call.args[1])).toContain(
      "restic/rest-server:0.13.0",
    );
    const lastPull = docker.map((call) => call.args[0]).lastIndexOf("pull");
    const firstUp = docker.findIndex(
      (call) => call.args[0] === "compose" && call.args.includes("up"),
    );
    expect(firstUp).toBeGreaterThan(lastPull);
    expect(docker.some((call) => call.args[0] === "build")).toBe(false);
    expect(result.stdout).toContain("must resolve to this machine");
    expect(result.stdout).toContain("outside host firewalls");
    expect(result.stdout).toContain("Keep the generated backup password");
    expect(result.stdout).toContain("made the first backup");
    // Pairing comes before, and does not depend on, model sign-in.
    const steps = [
      "Save ",
      "Trust the local CA",
      "Pair your first browser",
      "Sign in to ChatGPT",
      "Optional, in the same guide",
    ].map((step) => result.stdout.indexOf(step));
    expect(steps.every((index) => index >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(result.stdout).toContain("does not need a model sign-in");
    expect(result.stdout).toContain("setup guide that opens after pairing");
    expect(result.stdout).toContain("Terminal fallback");
    // The fresh-install marker makes the first paired browser open setup.
    const marker = join(f.deploy, "data/settings/onboarding.json");
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
      schemaVersion: 1,
      revision: 0,
      freshInstall: true,
      steps: {},
    });
    expect(statSync(marker).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.deploy, "data/settings")).mode & 0o777).toBe(0o700);
    // Opts in to an OpenAI key set in the browser; it holds no key.
    const providers = join(f.deploy, "data/settings/model-providers.json");
    expect(JSON.parse(readFileSync(providers, "utf8"))).toEqual({
      schemaVersion: 1,
      revision: 0,
    });
    expect(statSync(providers).mode & 0o777).toBe(0o600);
  });

  it("diagnoses a supported host read-only, with no version, downloads or files", () => {
    const f = fixture();
    const result = f.run([
      "diagnose",
      "--origin",
      "https://assistant.local:8443",
    ]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    for (const line of [
      "[pass] engine: Docker Engine 28.1.0",
      "[pass] docker-layout: local system Docker socket at /var/run/docker.sock",
      "[pass] docker-architecture: Docker runs native arm64 images",
      "[pass] port: port 8443 is free",
      "[pass] origin: assistant.local resolves on this machine",
      "No blocking problems found",
    ])
      expect(result.stdout).toContain(line);
    expectUntouched(f);
  });

  it("diagnoses every blocking problem at once, redacting remote endpoints", () => {
    const f = fixture();
    mkdirSync(`${f.deploy}-witness`);
    const result = f.run(["diagnose"], {
      DOCKER_HOST: "tcp://admin:secret@remote.example:2376",
      TEST_PORT_BUSY: "1",
      TEST_DOCKER_ARCH: "x86_64",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("[blocked] docker-endpoint");
    expect(result.stdout).toContain("uses a tcp endpoint");
    expect(result.stdout).not.toContain("secret");
    expect(result.stdout).not.toContain("remote.example");
    expect(result.stdout).toContain("[blocked] port: port 8443 is already");
    expect(result.stdout).toContain("[blocked] docker-architecture");
    expect(result.stdout).toContain("-witness already exists");
    expect(result.stdout).toContain("[unknown] origin: no browser address");
    expect(result.stdout).toContain("4 blocking problem(s) found");
    expect(f.calls().some((call) => call.tool === "curl")).toBe(false);
    expect(existsSync(f.deploy)).toBe(false);
  });

  it.each([
    [
      "a remote SSH context",
      { TEST_DOCKER_ENDPOINT: "ssh://builder@remote.example" },
      "uses a ssh endpoint",
    ],
    [
      "rootless Docker",
      {
        TEST_DOCKER_ENDPOINT: "unix:///run/user/1000/docker.sock",
        TEST_DOCKER_SECURITY: "[name=seccomp name=rootless]",
      },
      "rootless Docker is not supported",
    ],
    [
      "a non-system Linux socket",
      { TEST_DOCKER_ENDPOINT: "unix:///home/me/.docker/desktop/docker.sock" },
      "is not the system socket",
    ],
    [
      "a non-Desktop engine on macOS",
      {
        TEST_OS: "Darwin",
        TEST_DOCKER_ENDPOINT: "unix:///Users/me/.colima/default/docker.sock",
        TEST_DOCKER_OS: "Ubuntu 24.04 LTS (containerized)",
      },
      "only Docker Desktop is supported on macOS",
    ],
    [
      "an emulated daemon",
      { TEST_DOCKER_ARCH: "x86_64" },
      "Docker runs amd64 images on this arm64 host",
    ],
    ["a busy HTTPS port", { TEST_PORT_BUSY: "1" }, "port 8443 is already"],
  ])(
    "refuses %s before downloading or changing anything",
    (_name, extra, message) => {
      const f = fixture();
      const result = f.install(extra);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain(
        "prerequisite checks failed; nothing was changed",
      );
      expectUntouched(f);
    },
  );

  it("accepts Docker Desktop's own socket on macOS and warns about an unresolved name", () => {
    const f = fixture();
    const result = f.install({
      TEST_OS: "Darwin",
      TEST_DOCKER_ENDPOINT: "unix:///Users/me/.docker/run/docker.sock",
      TEST_UNRESOLVED: "1",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "warning: assistant.local does not resolve on this machine",
    );
    expect(existsSync(join(f.deploy, "server.json"))).toBe(true);
  });

  it("rejects a malformed release manifest without executing it or starting containers", () => {
    const f = fixture();
    writeFileSync(
      join(f.assets, "assistant-release.env"),
      `RELEASE_VERSION=1.2.3\nEVIL=$(touch ${f.root}/executed)\n`,
    );
    const result = f.run([
      "install",
      "--version",
      f.version,
      "--origin",
      "https://assistant.local:8443",
      "--yes",
    ]);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(f.root, "executed"))).toBe(false);
    expect(existsSync(f.deploy)).toBe(false);
  });

  it("refuses a manifest for another version and invalid browser origins", () => {
    const f = fixture();
    const wrong = f.run([
      "install",
      "--version",
      "9.9.9",
      "--origin",
      "https://assistant.local:8443",
      "--yes",
    ]);
    expect(wrong.stderr).toContain("does not match requested release");
    const invalid = f.run([
      "install",
      "--version",
      f.version,
      "--origin",
      'https://host:8443/", "injected":true',
      "--yes",
    ]);
    expect(invalid.stderr).toContain("--origin must be");
    expect(existsSync(f.deploy)).toBe(false);
  });

  it("leaves no deployment or lock when a required release asset cannot be downloaded", () => {
    const f = fixture();
    rmSync(join(f.assets, "compose.backup.yaml"));
    const result = f.run([
      "install",
      "--version",
      f.version,
      "--origin",
      "https://assistant.local:8443",
      "--yes",
    ]);
    expect(result.status).not.toBe(0);
    expect(existsSync(f.deploy)).toBe(false);
    expect(existsSync(join(f.root, ".agentlink-assistant-install.lock"))).toBe(
      false,
    );
    expect(f.calls().some((call) => call.args[0] === "pull")).toBe(false);
  });

  it("rejects a corrupted release asset before pulling images or creating install state", () => {
    const f = fixture();
    writeFileSync(join(f.assets, "compose.updater.yaml"), "services: {}\n");
    const result = f.run([
      "install",
      "--version",
      f.version,
      "--origin",
      "https://assistant.local:8443",
      "--yes",
    ]);
    expect(result.stderr).toContain(
      "release asset hash mismatch: compose.updater.yaml",
    );
    expect(existsSync(f.deploy)).toBe(false);
    expect(f.calls().some((call) => call.args[0] === "pull")).toBe(false);
  });

  it("refuses managed CLI updates before mutation and preserves deployment files", () => {
    const f = fixture();
    mkdirSync(f.deploy);
    writeFileSync(join(f.deploy, "server.json"), '{"ownerSetting": true}');
    writeFileSync(join(f.deploy, "compose.yaml"), "services: {}\n");
    writeFileSync(
      join(f.deploy, "assistant-deployment.json"),
      "managed metadata\n",
    );
    writeFileSync(join(f.deploy, "release.env"), "RELEASE_VERSION=1.0.0\n");
    copyFileSync(upgrade, join(f.deploy, "upgrade.sh"));
    const result = f.run(["update", "--version", f.version, "--yes"]);
    expect(result.stderr).toContain(
      "managed releases require Settings > Updates",
    );
    expect(readFileSync(join(f.deploy, "server.json"), "utf8")).toBe(
      '{"ownerSetting": true}',
    );
    expect(readFileSync(join(f.deploy, "release.env"), "utf8")).toBe(
      "RELEASE_VERSION=1.0.0\n",
    );
    expect(f.calls().some((call) => call.args[0] === "pull")).toBe(false);
    expect(f.calls().some((call) => call.args[0] === "tag")).toBe(false);
    expect(
      f
        .calls()
        .some(
          (call) => call.args[0] === "compose" && call.args[1] !== "version",
        ),
    ).toBe(false);
  });

  it("refuses managed CLI rollback before mutation and preserves deployment files", () => {
    const f = fixture();
    mkdirSync(f.deploy);
    writeFileSync(join(f.deploy, "server.json"), '{"ownerSetting": true}');
    writeFileSync(join(f.deploy, "compose.yaml"), "services: {}\n");
    writeFileSync(
      join(f.deploy, "assistant-deployment.json"),
      "managed metadata\n",
    );
    copyFileSync(upgrade, join(f.deploy, "upgrade.sh"));
    const result = f.run(["rollback", "--yes"]);
    expect(result.stderr).toContain(
      "managed releases require Settings > Updates",
    );
    expect(readFileSync(join(f.deploy, "server.json"), "utf8")).toBe(
      '{"ownerSetting": true}',
    );
    expect(
      f
        .calls()
        .some(
          (call) => call.args[0] === "compose" && call.args[1] !== "version",
        ),
    ).toBe(false);
    expect(f.calls().some((call) => call.args[0] === "pull")).toBe(false);
    expect(f.calls().some((call) => call.args[0] === "tag")).toBe(false);
  });

  it("refuses a downgrade and preserves the installed release metadata", () => {
    const f = fixture();
    mkdirSync(f.deploy);
    writeFileSync(join(f.deploy, "server.json"), '{"backup": {}}');
    writeFileSync(join(f.deploy, "compose.yaml"), "services: {}");
    copyFileSync(upgrade, join(f.deploy, "upgrade.sh"));
    writeFileSync(join(f.deploy, "release.env"), "RELEASE_VERSION=9.0.0\n");
    const result = f.run(["update", "--version", f.version, "--yes"]);
    expect(result.stderr).toContain("use rollback, not update");
    expect(readFileSync(join(f.deploy, "release.env"), "utf8")).toBe(
      "RELEASE_VERSION=9.0.0\n",
    );
    expect(f.calls().some((call) => call.args[0] === "pull")).toBe(false);
  });

  it("aborts an update before switching images when its pre-upgrade backup fails", () => {
    const f = fixture();
    mkdirSync(f.deploy);
    writeFileSync(join(f.deploy, "server.json"), '{"backup": {}}');
    writeFileSync(join(f.deploy, "compose.yaml"), "services: {}");
    copyFileSync(upgrade, join(f.deploy, "upgrade.sh"));
    const previous = "RELEASE_VERSION=1.0.0\n";
    writeFileSync(join(f.deploy, "release.env"), previous);
    const result = f.run(["update", "--version", f.version, "--yes"], {
      TEST_DOCKER_FAIL: "backup",
    });
    expect(result.stderr).toContain("backup failed; nothing was changed");
    expect(readFileSync(join(f.deploy, "release.env"), "utf8")).toBe(previous);
    expect(
      f
        .calls()
        .some(
          (call) =>
            call.args[0] === "tag" && call.args.at(-1)?.endsWith(":local"),
        ),
    ).toBe(false);
    expect(f.calls().some((call) => call.args.includes("resume"))).toBe(true);
  });

  it("leaves nothing behind when the witness image cannot be pulled", () => {
    const f = fixture();
    const result = f.install({ TEST_DOCKER_FAIL: "restic/rest-server:0.13.0" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not pull the backup witness image");
    expect(result.stderr).toContain("can be retried");
    expect(result.stderr).not.toContain("Retry startup");
    expect(existsSync(f.deploy)).toBe(false);
    expect(existsSync(`${f.deploy}-witness`)).toBe(false);
    expect(existsSync(`${f.deploy}-updater`)).toBe(false);
    expect(f.calls().some((call) => call.args[0] === "tag")).toBe(false);
    expect(existsSync(join(f.root, ".agentlink-assistant-install.lock"))).toBe(
      false,
    );
  });

  it("keeps a failed update supervisor start and prints recovery for all three projects", () => {
    const f = fixture();
    const result = f.install({
      TEST_DOCKER_FAIL: "up",
      TEST_DOCKER_FAIL_DIR: "-updater",
    });
    expect(result.status).not.toBe(0);
    const witnessUp = `(cd ${f.deploy}-witness && docker compose up -d)`;
    const updaterUp = `(cd ${f.deploy}-updater && docker compose up -d)`;
    const assistantUp = `(cd ${f.deploy} && docker compose up -d)`;
    for (const line of [witnessUp, updaterUp, assistantUp])
      expect(result.stderr).toContain(line);
    expect(result.stderr.indexOf(witnessUp)).toBeLessThan(
      result.stderr.indexOf(updaterUp),
    );
    expect(result.stderr.indexOf(updaterUp)).toBeLessThan(
      result.stderr.indexOf(assistantUp),
    );
    expect(result.stderr).toContain("do not regenerate config or secrets");
    const secret = readFileSync(
      join(f.deploy, "secrets/backup-password"),
      "utf8",
    );
    expect(readFileSync(`${f.deploy}-updater/updater-token`, "utf8")).toBe(
      readFileSync(join(f.deploy, "secrets/updater-token"), "utf8"),
    );
    // The retained install is refused, not overwritten, by a fresh rerun.
    const rerun = f.install();
    expect(rerun.stderr).toContain("already exists (nothing overwritten)");
    expect(
      readFileSync(join(f.deploy, "secrets/backup-password"), "utf8"),
    ).toBe(secret);
  });

  it("can retry a failed image download without leftover deployment state", () => {
    const f = fixture();
    const result = f.run(
      [
        "install",
        "--version",
        f.version,
        "--origin",
        "https://assistant.local:8443",
        "--yes",
      ],
      { TEST_DOCKER_FAIL: "pull" },
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(f.deploy)).toBe(false);
    expect(existsSync(`${f.deploy}-witness`)).toBe(false);
    expect(f.calls().some((call) => call.args[0] === "tag")).toBe(false);
  });

  it("pulls a final image line without a newline and still prints onboarding if the first backup fails", () => {
    const f = fixture();
    const file = join(f.assets, "assistant-release.env");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    writeFileSync(
      file,
      [
        ...lines.filter((line) => !line.startsWith("BACKUP_IMAGE=")),
        lines.find((line) => line.startsWith("BACKUP_IMAGE="))!,
      ].join("\n"),
    );
    const result = f.run(
      [
        "install",
        "--version",
        f.version,
        "--origin",
        "https://assistant.local:8443",
        "--yes",
      ],
      { TEST_DOCKER_FAIL: "backup" },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("first backup did not finish");
    expect(result.stdout).toContain(
      "setup is degraded: there is no backup yet",
    );
    expect(result.stdout).not.toContain("made the first backup");
    expect(result.stdout).toContain("Sign in to ChatGPT");
    expect(f.calls().filter((call) => call.args[0] === "pull")).toHaveLength(6);
  });

  it("keeps a failed startup and prints exact recovery commands instead of overwriting it", () => {
    const f = fixture();
    const result = f.run(
      [
        "install",
        "--version",
        f.version,
        "--origin",
        "https://assistant.local:8443",
        "--yes",
      ],
      { TEST_DOCKER_FAIL: "up" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Retry startup, in this order");
    expect(result.stderr).toContain("smoke-check");
    expect(existsSync(join(f.deploy, "server.json"))).toBe(true);
  });

  it("does not convert a source-built deployment or overwrite its configuration during update", () => {
    const f = fixture();
    mkdirSync(f.deploy);
    writeFileSync(join(f.deploy, "server.json"), "owner settings");
    writeFileSync(join(f.deploy, "compose.yaml"), "services: {}");
    copyFileSync(upgrade, join(f.deploy, "upgrade.sh"));
    const result = f.run(["update", "--version", f.version, "--yes"]);
    expect(result.stderr).toContain("source-built deployment");
    expect(readFileSync(join(f.deploy, "server.json"), "utf8")).toBe(
      "owner settings",
    );
  });
});

describe(
  "installer optional features, uninstall and recovery",
  {
    timeout: 30_000,
  },
  () => {
    /** A finished fresh installation, with the command log cleared. */
    function installed() {
      const f = fixture();
      const result = f.install();
      expect(result.status).toBe(0);
      rmSync(f.log, { force: true });
      const updater = `${f.deploy}-updater`;
      const read = (name: string) => readFileSync(join(f.deploy, name), "utf8");
      const journal = () =>
        JSON.parse(
          readFileSync(join(updater, ".lifecycle-state.json"), "utf8"),
        );
      const lock = join(updater, ".deployment-mutation-lock");
      const dockerCalls = () =>
        f.calls().filter((call) => call.tool === "docker");
      const compose = (...args: string[]) =>
        dockerCalls().filter(
          (call) =>
            call.args[0] === "compose" &&
            args.every((arg, index) => call.args[index + 1] === arg),
        );
      return { ...f, updater, read, journal, lock, dockerCalls, compose };
    }
    const image = (target: string) =>
      `ghcr.io/reefbarman/agentlink-${target}@sha256:${"b".repeat(64)}`;

    it("turns a feature on and off with only the installed release's template and image", () => {
      const f = installed();
      const env = f.read(".env");
      const config = f.read("server.json");
      const listed = f.run(["capabilities"]);
      expect(listed.status).toBe(0);
      expect(listed.stdout).toMatch(
        /editor\s+Edit task workspaces\s+disabled/u,
      );
      expect(listed.stdout).toMatch(
        /browser\s+Research with a browser\s+disabled/u,
      );
      expect(listed.stdout).toContain("Meridian");

      const enabled = f.run(["enable", "editor", "--yes"]);
      expect(enabled.stderr).toBe("");
      expect(enabled.status).toBe(0);
      expect(enabled.stdout).toContain("Port 8444 will listen");
      expect(f.read(".env")).toContain(
        "COMPOSE_FILE=compose.yaml:compose.publisher.yaml:compose.runners.yaml:compose.backup.yaml:compose.update-client.yaml:compose.editor.yaml\n",
      );
      const withEditor = JSON.parse(f.read("server.json"));
      expect(withEditor.editor).toEqual({ port: 8444 });
      expect(statSync(join(f.deploy, "server.json")).mode & 0o777).toBe(0o600);
      expect(f.read("compose.editor.yaml")).toBe(
        readFileSync(join(container, "compose.editor.yaml"), "utf8"),
      );
      const steps = f
        .dockerCalls()
        .map((call) =>
          call.args[0] === "pull" || call.args[0] === "tag"
            ? call.args.join(" ")
            : call.args.includes("drain")
              ? "drain"
              : call.args.includes("backup")
                ? "backup"
                : call.args.includes("up")
                  ? "up"
                  : call.args.includes("resume")
                    ? "resume"
                    : "",
        )
        .filter(Boolean);
      expect(steps).toEqual([
        `pull ${image("editor")}`,
        "drain",
        "backup",
        `tag ${image("editor")} agentlink-editor:local`,
        "up",
        "resume",
      ]);
      expect(f.journal()).toMatchObject({
        schemaVersion: 1,
        action: "enable",
        capability: "editor",
        status: "completed",
      });
      expect(existsSync(f.lock)).toBe(false);
      expect(
        readFileSync(join(f.updater, "lifecycle-recovery", "env"), "utf8"),
      ).toBe(env);
      expect(f.run(["capabilities"]).stdout).toMatch(/editor\s.*\senabled/u);
      // Asking again changes nothing.
      rmSync(f.log, { force: true });
      expect(f.run(["enable", "editor", "--yes"]).stdout).toContain(
        "already on",
      );
      expect(f.dockerCalls().some((call) => call.args[0] === "pull")).toBe(
        false,
      );

      const disabled = f.run(["disable", "editor", "--yes"], {
        TEST_CHILDREN: "1",
      });
      expect(disabled.status).toBe(0);
      expect(f.read(".env")).toBe(env);
      expect(f.read("server.json")).toBe(config);
      // The open editor is closed; the template stays for a later enable.
      expect(
        f
          .dockerCalls()
          .some((call) => call.args.join(" ") === "rm -f c0ffee00c0ff"),
      ).toBe(true);
      // A container that only shares the label is never touched.
      expect(
        f.dockerCalls().some((call) => call.args.includes("badd00dbadd0")),
      ).toBe(false);
      expect(existsSync(join(f.deploy, "compose.editor.yaml"))).toBe(true);
      expect(f.journal()).toMatchObject({
        action: "disable",
        status: "completed",
      });
    });

    it("retires an update's rollback point when a feature changes, so rollback stops nothing (update, enable editor, rollback)", () => {
      const f = installed();
      // A browser update to this release added compose.editor.yaml, which
      // had no earlier copy: its rollback would remove it.
      const previous = join(f.deploy, ".upgrade-assets-previous");
      mkdirSync(previous);
      copyFileSync(
        join(f.deploy, "compose.yaml"),
        join(previous, "compose.yaml"),
      );
      writeFileSync(
        join(previous, ".files"),
        "compose.yaml\ncompose.editor.yaml\n",
      );
      writeFileSync(
        join(f.deploy, ".upgrade-state"),
        "status=done\nstarted=2026-10-18T00:00:00Z\ncommit=aaaaaaaa\nsnapshot=abcdef12\nrelease=0\nassets=1\n",
      );

      const enabled = f.run(["enable", "editor", "--yes"]);
      expect(enabled.status).toBe(0);
      expect(enabled.stdout).toContain(
        "The last update can no longer be rolled back",
      );
      expect(f.read(".upgrade-state")).toContain("status=retired\n");
      expect(f.read(".upgrade-state")).toContain("snapshot=abcdef12\n");
      const env = f.read(".env");
      expect(env).toContain(":compose.editor.yaml\n");

      const rollback = () => {
        rmSync(f.log, { force: true });
        return spawnSync(
          process.env.AGENTLINK_TEST_BASH ?? "bash",
          [join(f.deploy, "upgrade.sh"), "--deploy", f.deploy, "rollback"],
          {
            encoding: "utf8",
            timeout: 15_000,
            env: {
              ...process.env,
              PATH: `${join(f.root, "bin")}:${process.env.PATH}`,
              TEST_LOG: f.log,
              TEST_ASSETS: f.assets,
              HOME: f.root,
              DOCKER_HOST: "",
              TEST_EXISTING_IMAGES: "1",
            },
          },
        );
      };
      const expectNothingStopped = () => {
        expect(f.compose("stop")).toEqual([]);
        expect(f.compose("up")).toEqual([]);
        expect(f.read(".env")).toBe(env);
        expect(existsSync(join(f.deploy, "compose.editor.yaml"))).toBe(true);
      };
      const retired = rollback();
      expect(retired.status).not.toBe(0);
      expect(retired.stderr).toContain("can no longer be rolled back");
      expect(retired.stdout).not.toContain("AGENTLINK_UPDATE_PHASE");
      expectNothingStopped();

      // Even a rollback point that was not retired never removes a
      // template the current .env uses.
      writeFileSync(
        join(f.deploy, ".upgrade-state"),
        f.read(".upgrade-state").replace("status=retired", "status=done"),
      );
      const active = rollback();
      expect(active.status).not.toBe(0);
      expect(active.stderr).toContain(
        "would remove compose.editor.yaml, which COMPOSE_FILE in .env uses now",
      );
      expectNothingStopped();
    });

    it("accepts only the fixed feature names", () => {
      const f = installed();
      for (const name of [
        "../compose.evil",
        "meridian",
        "compose.editor.yaml",
      ]) {
        const result = f.run(["enable", name, "--yes"]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("unknown optional feature");
      }
      expect(f.run(["enable", "--yes"]).stderr).toContain(
        "name the optional feature",
      );
      expect(f.run(["uninstall", "editor"]).stderr).toContain(
        "unexpected argument",
      );
      expect(f.calls()).toEqual([]);
    });

    it("puts the previous configuration back when the change does not start", () => {
      const f = installed();
      const env = f.read(".env");
      const config = f.read("server.json");
      const result = f.run(["enable", "browser", "--yes"], {
        TEST_DOCKER_FAIL: "config",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("change was undone");
      expect(f.read(".env")).toBe(env);
      expect(f.read("server.json")).toBe(config);
      expect(existsSync(join(f.deploy, "compose.browser.yaml"))).toBe(false);
      expect(f.journal()).toMatchObject({ status: "rolled-back" });
      expect(existsSync(f.lock)).toBe(false);
      // The drain is lifted after the old configuration is checked.
      expect(f.compose("exec", "-T", "assistant").at(-1)?.args).toContain(
        "resume",
      );
    });

    it("downloads and pulls before changing anything, and refuses a mismatched template", () => {
      const f = installed();
      const env = f.read(".env");
      writeFileSync(join(f.assets, "compose.editor.yaml"), "services: {}\n");
      const result = f.run(["enable", "editor", "--yes"]);
      expect(result.stderr).toContain("does not match this release");
      expect(f.read(".env")).toBe(env);
      expect(existsSync(join(f.deploy, "compose.editor.yaml"))).toBe(false);
      expect(f.dockerCalls().some((call) => call.args.includes("drain"))).toBe(
        false,
      );
      expect(existsSync(f.lock)).toBe(false);
    });

    it("refuses while an update holds the guard or has not settled, changing nothing", () => {
      const f = installed();
      const env = f.read(".env");
      mkdirSync(f.lock);
      writeFileSync(join(f.lock, "owner"), "kind=update\nid=x\n");
      const busy = f.run(["enable", "editor", "--yes"]);
      expect(busy.stderr).toContain("holds");
      expect(busy.stderr).toContain("kind=update");
      // Another command's guard is never removed.
      expect(existsSync(join(f.lock, "owner"))).toBe(true);
      expect(f.run(["recover", "--yes"]).stderr).toContain(
        "never clears an update's guard",
      );
      rmSync(f.lock, { recursive: true });

      writeFileSync(
        join(f.deploy, ".upgrade-state"),
        "status=rollback-failed\n",
      );
      expect(f.run(["enable", "editor", "--yes"]).stderr).toContain(
        "not settled (status rollback-failed)",
      );
      writeFileSync(join(f.deploy, ".upgrade-state"), "status=done\n");
      const id = "11111111-2222-4333-8444-555555555555";
      mkdirSync(join(f.updater, "operations"));
      writeFileSync(
        join(f.updater, "current-operation.json"),
        JSON.stringify({ id }),
      );
      writeFileSync(
        join(f.updater, "operations", `${id}.json`),
        JSON.stringify({ id, kind: "update", phase: "draining" }),
      );
      expect(f.run(["uninstall", "--yes"]).stderr).toContain(
        "browser update is draining",
      );
      writeFileSync(
        join(f.updater, "operations", `${id}.json`),
        JSON.stringify({ id, kind: "update", phase: "interrupted" }),
      );
      expect(f.run(["disable", "editor", "--yes"]).status).toBe(0); // already off
      expect(f.run(["enable", "editor", "--yes"]).stderr).toContain(
        "was interrupted",
      );
      expect(f.read(".env")).toBe(env);
      // The refusal comes before any download, pull or drain.
      expect(f.dockerCalls().some((call) => call.args[0] === "pull")).toBe(
        false,
      );
      expect(f.dockerCalls().some((call) => call.args.includes("drain"))).toBe(
        false,
      );
      expect(existsSync(f.lock)).toBe(false);
    });

    it("keeps an interrupted change blocked until recover puts the saved files back", () => {
      const f = installed();
      const env = f.read(".env");
      const config = f.read("server.json");
      // As if killed after changing .env: guard, journal and recovery set left.
      const recovery = join(f.updater, "lifecycle-recovery");
      mkdirSync(recovery);
      writeFileSync(join(recovery, "env"), env);
      writeFileSync(join(recovery, "server.json"), config);
      writeFileSync(join(recovery, "templates"), "compose.yaml\n");
      writeFileSync(join(recovery, "id"), "1-2\n");
      writeFileSync(
        join(f.updater, ".lifecycle-state.json"),
        `${JSON.stringify({ schemaVersion: 1, id: "1-2", action: "enable", capability: "editor", status: "applying", updatedAt: 1 })}\n`,
      );
      mkdirSync(f.lock);
      writeFileSync(join(f.lock, "owner"), "kind=capability\npid=999999\n");
      writeFileSync(join(f.deploy, ".env"), `${env}# half-written\n`);

      const blocked = f.run(["enable", "browser", "--yes"]);
      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain("recover");
      rmSync(f.lock, { recursive: true });
      // Even with the guard gone, the journal still blocks.
      expect(f.run(["uninstall", "--yes"]).stderr).toContain(
        "did not finish (status applying)",
      );

      const recovered = f.run(["recover", "--yes"]);
      expect(recovered.stderr).toBe("");
      expect(recovered.status).toBe(0);
      expect(f.read(".env")).toBe(env);
      expect(f.read("server.json")).toBe(config);
      expect(f.journal()).toMatchObject({ id: "1-2", status: "recovered" });
      expect(existsSync(f.lock)).toBe(false);
      expect(f.run(["recover", "--yes"]).stdout).toContain(
        "Nothing to recover",
      );
    });

    it("does not recover from a saved set that belongs to another change", () => {
      const f = installed();
      const recovery = join(f.updater, "lifecycle-recovery");
      mkdirSync(recovery);
      for (const name of ["env", "server.json", "templates"])
        writeFileSync(join(recovery, name), "x\n");
      writeFileSync(join(recovery, "id"), "other\n");
      writeFileSync(
        join(f.updater, ".lifecycle-state.json"),
        `${JSON.stringify({ schemaVersion: 1, id: "1-2", action: "disable", capability: "browser", status: "applying", updatedAt: 1 })}\n`,
      );
      const result = f.run(["recover", "--yes"]);
      expect(result.stderr).toContain("does not match the unfinished change");
      expect(f.read(".env")).not.toBe("x\n");
      // Still blocked, and the guard is kept for the operator.
      expect(existsSync(f.lock)).toBe(true);
    });

    it("refuses modified templates and an unreadable journal before running Compose", () => {
      const f = installed();
      const compose = f.read("compose.yaml");
      writeFileSync(join(f.deploy, "compose.yaml"), `${compose}# edited\n`);
      const edited = f.run(["uninstall", "--yes"]);
      expect(edited.status).not.toBe(0);
      expect(edited.stderr).toContain("differs from this release's copy");
      expect(f.run(["enable", "browser", "--yes"]).stderr).toContain(
        "differs from this release's copy",
      );
      writeFileSync(join(f.deploy, "compose.yaml"), compose);

      const supervisor = readFileSync(join(f.updater, "compose.yaml"), "utf8");
      writeFileSync(join(f.updater, "compose.yaml"), `${supervisor}# edited\n`);
      expect(f.run(["uninstall", "--yes"]).stderr).toContain(
        `${f.updater}/compose.yaml differs`,
      );
      writeFileSync(join(f.updater, "compose.yaml"), supervisor);
      expect(f.compose("down")).toEqual([]);

      for (const broken of [
        "{not json",
        JSON.stringify({ status: "completed" }),
      ]) {
        writeFileSync(join(f.updater, ".lifecycle-state.json"), broken);
        const recovered = f.run(["recover", "--yes"]);
        expect(recovered.status).not.toBe(0);
        expect(recovered.stderr).toContain("cannot be read");
        expect(f.run(["enable", "editor", "--yes"]).stderr).toContain(
          "status unreadable",
        );
      }
      expect(f.dockerCalls().some((call) => call.args[0] === "pull")).toBe(
        false,
      );
    });

    it("uninstalls without deleting anything and resumes the same installation", () => {
      const f = installed();
      const files = [
        join(f.deploy, "server.json"),
        join(f.deploy, "secrets", "backup-password"),
        join(f.deploy, "data", "settings", "onboarding.json"),
        join(f.updater, "updater-token"),
        join(`${f.deploy}-witness`, "compose.yaml"),
      ];
      const before = files.map((file) => readFileSync(file, "utf8"));
      const result = f.run(["uninstall", "--yes"], { TEST_CHILDREN: "1" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Nothing is deleted");
      expect(result.stdout).toContain("resume --deploy");
      expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
      const downs = f.compose("down");
      expect(downs.map((call) => realpathSync(call.cwd))).toEqual(
        [f.deploy, f.updater, `${f.deploy}-witness`].map((dir) =>
          realpathSync(dir),
        ),
      );
      // Never a volume, image or system-wide removal.
      expect(
        f
          .dockerCalls()
          .some(
            (call) =>
              call.args.includes("-v") ||
              call.args.includes("--volumes") ||
              call.args.includes("--rmi") ||
              call.args.includes("prune"),
          ),
      ).toBe(false);
      expect(
        f
          .dockerCalls()
          .filter((call) => call.args.join(" ") === "rm -f c0ffee00c0ff"),
      ).toHaveLength(3);
      expect(
        f.dockerCalls().some((call) => call.args.includes("badd00dbadd0")),
      ).toBe(false);
      expect(result.stdout).toContain("1 runner container(s)");
      expect(f.journal()).toMatchObject({
        action: "uninstall",
        status: "uninstalled",
      });
      expect(existsSync(f.lock)).toBe(false);
      expect(f.run(["enable", "editor", "--yes"]).stderr).toContain(
        "uninstalled; start it again first",
      );

      rmSync(f.log, { force: true });
      const resumed = f.run(["resume", "--yes"]);
      expect(resumed.status).toBe(0);
      expect(
        f.compose("up", "-d").map((call) => realpathSync(call.cwd)),
      ).toEqual(
        [`${f.deploy}-witness`, f.updater, f.deploy].map((dir) =>
          realpathSync(dir),
        ),
      );
      expect(f.compose("exec", "-T", "assistant").at(-1)?.args).toContain(
        "resume",
      );
      expect(f.journal()).toMatchObject({ status: "resumed" });
      expect(f.run(["resume", "--yes"]).stdout).toContain("nothing to resume");
    });

    it("refuses an installation whose release predates the guard, or a hand-edited configuration", () => {
      const f = installed();
      const metadata = join(f.deploy, "assistant-deployment.json");
      const original = readFileSync(metadata, "utf8");
      writeFileSync(
        metadata,
        original.replace(/^\s*"lifecycleProtocol": 1,\n/mu, ""),
      );
      expect(f.run(["enable", "editor", "--yes"]).stderr).toContain(
        "predates safe optional-feature changes",
      );
      writeFileSync(metadata, original);
      const config = f.read("server.json");
      writeFileSync(
        join(f.deploy, "server.json"),
        config.replace(
          '  "projectsRoot"',
          '  "browser": {"idleMinutes": 5},\n  "projectsRoot"',
        ),
      );
      expect(f.run(["enable", "browser", "--yes"]).stderr).toContain(
        "set up by hand",
      );
      writeFileSync(join(f.deploy, "server.json"), config);
      writeFileSync(
        join(f.deploy, ".env"),
        `${f.read(".env")}COMPOSE_FILE=compose.yaml\n`,
      );
      expect(f.run(["enable", "editor", "--yes"]).stderr).toContain(
        "exactly one COMPOSE_FILE",
      );
      expect(f.dockerCalls().some((call) => call.args[0] === "pull")).toBe(
        false,
      );
    });

    it("refuses the editor when port 8444 is taken", () => {
      const f = installed();
      const result = f.run(["enable", "editor", "--yes"], {
        TEST_PORT_BUSY: "1",
      });
      expect(result.stderr).toContain("port 8444 is already in use");
      expect(f.calls().some((call) => call.tool === "curl")).toBe(false);
    });
  },
);
