import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
fs.appendFileSync(process.env.TEST_LOG,JSON.stringify({tool,args})+'\\n');
if(tool==='id'){ console.log('1000'); }
else if(tool==='uname'){ console.log(args[0]==='-s' ? (process.env.TEST_OS||'Linux') : 'arm64'); }
else if(tool==='docker'){
 if(args[0]==='image' && args[1]==='inspect') process.exit(process.env.TEST_EXISTING_IMAGES ? 0 : 1);
 if(args[0]==='ps' && process.env.TEST_EXISTING_CONTAINERS) console.log('existing-container');
 if(args[0]==='version') console.log(process.env.TEST_DOCKER_VERSION||'28.1.0');
 if(process.env.TEST_DOCKER_FAIL && args.includes(process.env.TEST_DOCKER_FAIL)) process.exit(1);
 if(args.includes('export-ca')) console.log('PUBLIC CERTIFICATE');
 if(args.includes('backup')) console.log('Backup abcdef12 done.');
}
else if(tool==='curl'){
 const url=args.find(x=>x.startsWith('https://')), name=url.split('/').pop();
 fs.copyFileSync(path.join(process.env.TEST_ASSETS,name),args[args.indexOf('--output')+1]);
}
`;
  for (const name of ["id", "uname", "docker", "curl"]) {
    const file = join(bin, name);
    writeFileSync(file, mock);
    chmodSync(file, 0o755);
  }
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync("bash", [installer, ...args, "--deploy", deploy], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_LOG: log,
        TEST_ASSETS: assets,
        HOME: root,
        ...extra,
      },
    });
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { tool: string; args: string[] })
      : [];
  return { root, assets, deploy, log, version, run, calls };
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
    expect(docker.filter((call) => call.args[0] === "pull")).toHaveLength(5);
    expect(
      docker
        .filter((call) => call.args[0] === "pull")
        .every((call) => call.args[1]!.includes("@sha256:")),
    ).toBe(true);
    expect(docker.some((call) => call.args[0] === "build")).toBe(false);
    expect(result.stdout).toContain("must resolve to this machine");
    expect(result.stdout).toContain("Sign in to ChatGPT");
    expect(result.stdout).toContain("Keep the generated backup password");
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
    expect(result.stdout).toContain("Sign in to ChatGPT");
    expect(f.calls().filter((call) => call.args[0] === "pull")).toHaveLength(5);
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
    expect(result.stderr).toContain("Retry startup:");
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
