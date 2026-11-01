import {
  cleanUpInstallFixtures,
  expectUntouched,
  fixture,
} from "./guidedInstallHarness.js";
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";

import { join } from "node:path";

// Release, update and failure scenarios are in guidedInstallUpdates.test.ts;
// optional features and recovery are in guidedInstallFeatures.test.ts and
// guidedInstallRecovery.test.ts, so Vitest can run them in parallel.
cleanUpInstallFixtures();

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
      "restic/rest-server:0.14.0@sha256:d2aff06f47eb38637dff580c3e6bce4af98f386c396a25d32eb6727ec96214a5",
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
});
