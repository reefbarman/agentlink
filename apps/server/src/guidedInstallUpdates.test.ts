import {
  cleanUpInstallFixtures,
  fixture,
  upgrade,
} from "./guidedInstallHarness.js";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { describe, expect, it } from "vitest";

import { join } from "node:path";

// Split from guidedInstall.test.ts so Vitest can run the slow installer
// scenarios in parallel.
cleanUpInstallFixtures();

// Each scenario launches multiple real shell subprocesses for hash validation.
// Keep the test budget above the fixture's bounded installer process timeout.
describe("guided release installer", { timeout: 20_000 }, () => {
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
    const result = f.install({
      TEST_DOCKER_FAIL:
        "restic/rest-server:0.14.0@sha256:d2aff06f47eb38637dff580c3e6bce4af98f386c396a25d32eb6727ec96214a5",
    });
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
