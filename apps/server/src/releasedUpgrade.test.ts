import { describe, expect, it } from "vitest";

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const upgrade = path.join(import.meta.dirname, "..", "deploy", "upgrade.sh");
const commit = "a".repeat(40);
const targets = ["assistant", "command-worker", "publisher", "backup"] as const;

function manifest(version = "1.2.3"): string {
  return [
    `RELEASE_VERSION=${version}`,
    `RELEASE_COMMIT=${commit}`,
    ...targets.map(
      (target) =>
        `${target === "command-worker" ? "COMMAND_WORKER" : target.toUpperCase()}_IMAGE=ghcr.io/reefbarman/agentlink-${target}@sha256:${"b".repeat(64)}`,
    ),
    "",
  ].join("\n");
}

async function fixture(
  options: { startFails?: boolean; smokeFails?: boolean } = {},
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-release-upgrade-"),
  );
  const deploy = path.join(root, "deploy");
  const bin = path.join(root, "bin");
  await fs.mkdir(deploy);
  await fs.mkdir(bin);
  await fs.writeFile(path.join(deploy, "compose.yaml"), "services: {}\n");
  await fs.writeFile(path.join(deploy, "server.json"), "{}\n");
  const manifestPath = path.join(root, "release.manifest");
  await fs.writeFile(manifestPath, manifest());
  const calls = path.join(root, "docker.log");
  const smokeCount = path.join(root, "smoke-count");
  const rollbackMarker = path.join(root, "rollback-started");
  await fs.writeFile(
    path.join(bin, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$1" = compose ] && [ "$2" = stop ]; then touch "$ROLLBACK_MARKER"; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  case "$3" in *:previous) exit 0 ;; esac
  exit 1
fi
if [ "$1" = compose ]; then
  case "$2" in
    up)
      ${options.startFails ? "exit 1" : "exit 0"}
      ;;
    exec)
      case "$*" in
        *smoke-check*)
          count=0
          [ -f "$SMOKE_COUNT" ] && count=$(cat "$SMOKE_COUNT")
          count=$((count + 1))
          printf '%s\\n' "$count" > "$SMOKE_COUNT"
          ${options.smokeFails ? 'if [ ! -f "$ROLLBACK_MARKER" ]; then exit 1; fi' : ""}
          exit 0
          ;;
      esac
      exit 0
      ;;
  esac
fi
exit 0
`,
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(bin, "date"),
    `#!/bin/sh
if [ "$1" = +%s ]; then
  count=0
  [ -f "$DATE_COUNT" ] && count=$(cat "$DATE_COUNT")
  count=$((count + 200))
  printf '%s\\n' "$count" > "$DATE_COUNT"
  printf '%s\\n' "$count"
else
  /bin/date "$@"
fi
`,
    { mode: 0o755 },
  );
  await fs.writeFile(path.join(bin, "sleep"), `#!/bin/sh\nexit 0\n`, {
    mode: 0o755,
  });
  return { root, deploy, bin, calls, smokeCount, rollbackMarker, manifestPath };
}

async function run(
  fx: Awaited<ReturnType<typeof fixture>>,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  return execFileAsync("/bin/bash", [upgrade, "--deploy", fx.deploy, ...args], {
    env: {
      ...process.env,
      PATH: `${fx.bin}:${process.env.PATH}`,
      DOCKER_LOG: fx.calls,
      SMOKE_COUNT: fx.smokeCount,
      ROLLBACK_MARKER: fx.rollbackMarker,
      DATE_COUNT: path.join(fx.root, "date-count"),
      ...extraEnv,
    },
  });
}

describe("released-image upgrade", () => {
  it("validates strictly and refuses invalid manifests before Docker", async () => {
    const fx = await fixture();
    const original = manifest().replace(
      "RELEASE_VERSION=1.2.3",
      "RELEASE_VERSION=1.2.3\nUNKNOWN=x",
    );
    await fs.writeFile(fx.manifestPath, original);
    await expect(
      run(fx, ["--release-manifest", fx.manifestPath, "--validate-release"]),
    ).rejects.toMatchObject({ code: 1 });
    await expect(fs.access(fx.calls)).rejects.toThrow();
    await fs.rm(fx.root, { recursive: true, force: true });
  });

  it("validates without requiring Docker or changing deployment metadata", async () => {
    const fx = await fixture();
    await fs.rm(path.join(fx.bin, "docker"));
    await expect(
      run(fx, ["--release-manifest", fx.manifestPath, "--validate-release"]),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining("manifest is valid"),
    });
    await expect(
      fs.access(path.join(fx.deploy, "release.env")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(fx.deploy, ".upgrade-lock")),
    ).rejects.toThrow();
    await fs.rm(fx.root, { recursive: true, force: true });
  });

  it("still builds source deployments without invoking the release pull path", async () => {
    const fx = await fixture();
    try {
      const source = path.join(fx.root, "source");
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, "package-lock.json"), "{}\n");
      await fs.writeFile(path.join(source, ".agentlink-commit"), "abcdef12\n");
      await fs.writeFile(
        path.join(fx.bin, "npm"),
        '#!/bin/sh\nprintf "npm %s\\n" "$*" >> "$DOCKER_LOG"\nmkdir -p node_modules\n',
        { mode: 0o755 },
      );
      await run(fx, ["--source", source, "--no-backup"]);
      const calls = await fs.readFile(fx.calls, "utf8");
      expect(calls).toContain("npm run build:workspaces");
      expect(calls).toContain("build -q --target assistant");
      expect(calls).not.toContain("pull ghcr.io");
      expect(
        await fs.readFile(path.join(fx.deploy, ".upgrade-state"), "utf8"),
      ).toContain("release=0");
      await expect(
        fs.access(path.join(fx.deploy, "release.env")),
      ).rejects.toThrow();
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("names an interrupted lock and gives a non-destructive recovery instruction", async () => {
    const fx = await fixture();
    try {
      await fs.mkdir(path.join(fx.deploy, ".upgrade-lock"));
      await expect(run(fx, ["rollback"])).rejects.toMatchObject({
        stderr: expect.stringContaining("rmdir"),
      });
      await expect(
        fs.access(path.join(fx.deploy, ".upgrade-lock")),
      ).resolves.toBeUndefined();
      await expect(fs.access(fx.calls)).rejects.toThrow();
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("pulls immutable images without npm/build and restores prior metadata on rollback", async () => {
    const fx = await fixture();
    const oldManifest =
      "RELEASE_VERSION=0.9.0\nRELEASE_COMMIT=" + "c".repeat(40) + "\n";
    await fs.writeFile(path.join(fx.deploy, "release.env"), oldManifest);
    await run(fx, ["--release-manifest", fx.manifestPath, "--no-backup"]);
    const calls = await fs.readFile(fx.calls, "utf8");
    expect(calls).toContain(
      "pull ghcr.io/reefbarman/agentlink-assistant@sha256:",
    );
    expect(calls).toContain(
      "tag ghcr.io/reefbarman/agentlink-assistant@sha256:",
    );
    expect(calls).not.toMatch(/build|npm/u);
    expect(await fs.readFile(path.join(fx.deploy, "release.env"), "utf8")).toBe(
      await fs.readFile(fx.manifestPath, "utf8"),
    );
    await run(fx, ["rollback"]);
    expect(await fs.readFile(path.join(fx.deploy, "release.env"), "utf8")).toBe(
      oldManifest,
    );
    await fs.rm(fx.root, { recursive: true, force: true });
  });

  it.each([
    ["start failure", { startFails: true }],
    ["health failure", { smokeFails: true }],
  ])(
    "rolls back and preserves prior release metadata after %s",
    async (_name, options) => {
      const fx = await fixture(options);
      const oldManifest =
        "RELEASE_VERSION=0.9.0\nRELEASE_COMMIT=" + "c".repeat(40) + "\n";
      await fs.writeFile(path.join(fx.deploy, "release.env"), oldManifest);
      await expect(
        run(fx, ["--release-manifest", fx.manifestPath, "--no-backup"]),
      ).rejects.toMatchObject({ code: 1 });
      expect(
        await fs.readFile(path.join(fx.deploy, "release.env"), "utf8"),
      ).toBe(oldManifest);
      const calls = await fs.readFile(fx.calls, "utf8");
      expect(calls).toContain("compose stop");
      expect(calls).toContain("compose up -d");
      await fs.rm(fx.root, { recursive: true, force: true });
    },
  );
});
