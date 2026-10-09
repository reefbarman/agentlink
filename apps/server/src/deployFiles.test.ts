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
