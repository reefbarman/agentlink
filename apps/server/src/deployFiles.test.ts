import { describe, expect, it } from "vitest";

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const deploy = path.join(import.meta.dirname, "..", "deploy");
const execFileAsync = promisify(execFile);

/** `Key=value` lines of one systemd section, comments excluded. */
function unitSection(unit: string, section: string): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  let current = "";
  for (const raw of unit.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[(.+)\]$/u.exec(line);
    if (header) {
      current = header[1]!;
      continue;
    }
    if (current !== section) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    entries.set(key, [...(entries.get(key) ?? []), line.slice(separator + 1)]);
  }
  return entries;
}

describe("deployment files", () => {
  it("ships a hardened systemd unit for a dedicated service user", async () => {
    const unit = await fs.readFile(
      path.join(deploy, "systemd", "agentlink-server.service"),
      "utf8",
    );
    const service = unitSection(unit, "Service");
    expect(service.get("ExecStart")?.[0]).toMatch(
      /agentlink-server\.js --config \/etc\/agentlink\/server\.json$/u,
    );
    expect(service.get("User")).toEqual(["agentlink"]);
    expect(service.get("StateDirectory")).toEqual(["agentlink"]);
    expect(service.get("StateDirectoryMode")).toEqual(["0700"]);
    expect(service.get("UMask")).toEqual(["0077"]);
    expect(service.get("KillMode")).toEqual(["mixed"]);
    for (const [key, value] of [
      ["NoNewPrivileges", "yes"],
      ["ProtectSystem", "strict"],
      ["ProtectHome", "yes"],
      ["PrivateTmp", "yes"],
      ["CapabilityBoundingSet", ""],
    ] as const) {
      expect(service.get(key), key).toEqual([value]);
    }
    // V8's JIT needs writable executable memory.
    expect(service.has("MemoryDenyWriteExecute")).toBe(false);
    expect(unitSection(unit, "Install").get("WantedBy")).toEqual([
      "multi-user.target",
    ]);
  });

  it("ships a non-root container image and a hardened compose service", async () => {
    const container = path.join(deploy, "container");
    const dockerfile = await fs.readFile(
      path.join(container, "Dockerfile"),
      "utf8",
    );
    const stages = dockerfile.split(/^(?=FROM )/mu).slice(1);
    const stage = (name: string) =>
      stages.find((text) => text.split("\n")[0]!.endsWith(` AS ${name}`))!;
    // The assistant is the default (last) target and has no shell: no RUN,
    // only Node and the bundle, whose shebang points at Node directly.
    const assistant = stage("assistant");
    expect(stages.at(-1)).toBe(assistant);
    expect(assistant).toMatch(/^FROM gcr\.io\/distroless\/nodejs22-/mu);
    expect(assistant).not.toMatch(/^RUN /mu);
    expect(assistant).toMatch(/^USER 1000:1000$/mu);
    expect(assistant).toMatch(/^ENTRYPOINT \["agentlink-server"\]$/mu);
    expect(assistant).toContain(
      "AGENTLINK_SERVER_CONFIG=/etc/agentlink/server.json",
    );
    expect(stage("bundle")).toContain("#!/nodejs/bin/node");
    const worker = stage("command-worker");
    expect(worker).toMatch(/^FROM node:22-/mu);
    expect(worker).toMatch(/^USER node$/mu);
    expect(worker).toMatch(
      /^ENTRYPOINT \["agentlink-server", "command-worker"\]$/mu,
    );
    // The build context admits only the bundle.
    const ignore = await fs.readFile(
      path.join(deploy, "..", ".dockerignore"),
      "utf8",
    );
    expect(
      ignore.split("\n").filter((line) => line && !line.startsWith("#")),
    ).toEqual(["*", "!dist/agentlink-server.js"]);

    const compose = await fs.readFile(
      path.join(container, "compose.yaml"),
      "utf8",
    );
    for (const line of [
      "read_only: true",
      "init: true",
      "pull_policy: never",
      "- ALL",
      "- no-new-privileges:true",
      "- ./server.json:/etc/agentlink/server.json:ro",
      "stop_grace_period: 60s",
    ]) {
      expect(compose, line).toContain(`      ${line}`.trimStart());
    }
    expect(compose).toMatch(/^ {4}cap_drop:\n {6}- ALL$/mu);
    expect(compose).not.toMatch(/privileged:\s*true|network_mode:\s*host/u);

    // The worker: hardened, unpublished, on an internal network only, and
    // with no access to the assistant's data directory or its secrets.
    const workerService = compose.slice(
      compose.indexOf("\n  command-worker:\n"),
      compose.indexOf("\nnetworks:\n"),
    );
    for (const line of [
      "read_only: true",
      "init: true",
      "pull_policy: never",
      "- no-new-privileges:true",
      "pids_limit:",
      "mem_limit:",
      "- ./projects:/srv/agentlink/projects",
      "target: command-worker-token",
    ]) {
      expect(workerService, line).toContain(line);
    }
    expect(workerService).toMatch(/^ {4}cap_drop:\n {6}- ALL$/mu);
    expect(workerService).toMatch(/^ {4}networks:\n {6}- command-worker\n/mu);
    expect(workerService).not.toMatch(/^\s+ports:/mu);
    expect(workerService).not.toMatch(/\.\/data|server\.json|meridian/u);
    expect(compose).toMatch(
      /^networks:\n {2}command-worker:\n {4}internal: true$/mu,
    );
    const assistantService = compose.slice(
      compose.indexOf("\n  assistant:\n"),
      compose.indexOf("\n  command-worker:\n"),
    );
    expect(assistantService).toMatch(
      /^ {4}networks:\n {6}- default\n {6}- command-worker$/mu,
    );
  });

  it("runs Meridian unpublished and hardened, keyed by a shared secret", async () => {
    const overlay = await fs.readFile(
      path.join(deploy, "container", "compose.meridian.yaml"),
      "utf8",
    );
    const meridian = overlay.slice(overlay.indexOf("\n  meridian:\n"));
    const service = meridian.slice(0, meridian.indexOf("\nsecrets:\n"));
    // Never reachable from the host or LAN, only from this project.
    expect(service).not.toMatch(/^\s+ports:/mu);
    expect(service).not.toMatch(/network_mode|privileged/u);
    for (const line of [
      "read_only: true",
      "pull_policy: never",
      "- no-new-privileges:true",
      "MERIDIAN_DEFAULT_AGENT: passthrough",
      "- ./meridian:/home/claude",
    ]) {
      expect(service, line).toContain(line);
    }
    expect(service).toMatch(/^ {4}cap_drop:\n {6}- ALL$/mu);
    // The key is read from the secret inside the container, never inlined.
    expect(service).toContain(
      'export MERIDIAN_API_KEY="$$(cat /run/secrets/meridian-api-key)"',
    );
    expect(overlay).not.toMatch(/MERIDIAN_API_KEY:/u);
    expect(overlay).toMatch(
      /^secrets:\n {2}meridian_api_key:\n {4}file: \.\/secrets\/meridian-api-key$/mu,
    );
    // The assistant gets the same secret for its provider apiKey file.
    const assistant = overlay.slice(
      overlay.indexOf("\n  assistant:\n"),
      overlay.indexOf("\n  meridian:\n"),
    );
    expect(assistant).toContain("target: meridian-api-key");
  });

  it("ships a launchd daemon that runs as a service user", async () => {
    const file = path.join(deploy, "launchd", "local.agentlink.server.plist");
    const plist = await fs.readFile(file, "utf8");
    expect(plist).toMatch(
      /<key>Label<\/key>\s*<string>local\.agentlink\.server<\/string>/u,
    );
    expect(plist).toMatch(
      /<string>--config<\/string>\s*<string>\/usr\/local\/etc\/agentlink\/server\.json<\/string>/u,
    );
    expect(plist).toMatch(
      /<key>UserName<\/key>\s*<string>_agentlink<\/string>/u,
    );
    expect(plist).toMatch(/<key>Umask<\/key>\s*<integer>63<\/integer>/u);
    if (process.platform === "darwin") {
      await expect(
        execFileAsync("/usr/bin/plutil", ["-lint", file]),
      ).resolves.toMatchObject({ stdout: expect.stringContaining("OK") });
    }
  });
});
