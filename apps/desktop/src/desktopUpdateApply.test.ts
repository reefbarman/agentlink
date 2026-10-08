import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDesktopUpdateApplyScript,
  shellQuote,
  type DesktopPendingUpdate,
} from "./desktopUpdateApply.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "desktop-apply-'quoted-\\backslash-"),
  );
  roots.push(root);
  const destination = path.join(root, "AgentLink's App.app");
  const stage = path.join(root, ".agentlink-update-123");
  const staged = path.join(stage, "AgentLink.app");
  for (const [bundle, version] of [
    [destination, "1.0.0"],
    [staged, "1.1.0"],
  ]) {
    await mkdir(path.join(bundle, "Contents"), { recursive: true });
    await writeFile(
      path.join(bundle, "Contents/Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
    );
    await writeFile(path.join(bundle, "version"), version);
  }
  const pending: DesktopPendingUpdate = {
    version: "1.1.0",
    destination,
    staged,
    backup: path.join(stage, "previous.app"),
    destinationFingerprint: {
      inode: (await lstat(destination, { bigint: true })).ino.toString(),
      version: "1.0.0",
    },
  };
  const resultPath = path.join(root, "apply-result.json");
  const launched = path.join(root, "launched");
  const run = async (extra = "", pid = 99999999) => {
    const script = path.join(stage, "apply.sh");
    const body = buildDesktopUpdateApplyScript({
      pending,
      appPid: pid,
      resultPath,
      appWaitSeconds: 0,
      processWaitSeconds: 0,
    });
    // Never invoke LaunchServices or mutate a real installation from these tests.
    await writeFile(
      script,
      body.replace(
        "export PATH\n",
        `export PATH\nopen() { printf '%s\\n' "$1" >> ${shellQuote(launched)}; }\n${extra}\n`,
      ),
    );
    return execute("/bin/sh", [script]);
  };
  return { pending, resultPath, launched, run };
}

describe.skipIf(process.platform !== "darwin")(
  "detached Desktop apply script",
  () => {
    it("swaps temp bundles safely with quoted paths, records before launch, and retains backup", async () => {
      const f = await fixture();
      await f.run(
        `open() { [ -f "$RESULT" ] || return 1; printf '%s\\n' "$1" >> ${shellQuote(f.launched)}; }`,
      );
      expect(
        await readFile(path.join(f.pending.destination, "version"), "utf8"),
      ).toBe("1.1.0");
      expect(
        await readFile(path.join(f.pending.backup, "version"), "utf8"),
      ).toBe("1.0.0");
      expect(JSON.parse(await readFile(f.resultPath, "utf8"))).toEqual({
        status: "applied",
      });
      expect(await readFile(f.launched, "utf8")).toContain(
        f.pending.destination,
      );
    });

    it("leaves a changed destination untouched", async () => {
      const f = await fixture();
      f.pending.destinationFingerprint.inode = "0";
      await expect(f.run()).rejects.toThrow();
      expect(
        await readFile(path.join(f.pending.destination, "version"), "utf8"),
      ).toBe("1.0.0");
      expect(JSON.parse(await readFile(f.resultPath, "utf8"))).toEqual({
        status: "failed",
        message: "destination_changed",
      });
    });

    it("rolls back if the second rename fails and retains staged recovery files", async () => {
      const f = await fixture();
      await expect(
        f.run('mv() { [ "$1" != "$STAGED" ] || return 1; /bin/mv "$@"; }'),
      ).rejects.toThrow();
      expect(
        await readFile(path.join(f.pending.destination, "version"), "utf8"),
      ).toBe("1.0.0");
      expect(
        await readFile(path.join(f.pending.staged, "version"), "utf8"),
      ).toBe("1.1.0");
      expect(JSON.parse(await readFile(f.resultPath, "utf8"))).toEqual({
        status: "failed",
        message: "activation_rename_failed",
      });
    });

    it("retains the old backup if rollback itself fails", async () => {
      const f = await fixture();
      await expect(
        f.run(
          'mv() { case "$1" in "$STAGED"|"$BACKUP") return 1;; esac; /bin/mv "$@"; }',
        ),
      ).rejects.toThrow();
      expect(
        await readFile(path.join(f.pending.backup, "version"), "utf8"),
      ).toBe("1.0.0");
      expect(JSON.parse(await readFile(f.resultPath, "utf8"))).toEqual({
        status: "failed",
        message: "rollback_backup_restore_failed",
      });
    });

    it("restores the original bundle if launch fails", async () => {
      const f = await fixture();
      await expect(f.run("open() { return 1; }")).rejects.toThrow();
      expect(
        await readFile(path.join(f.pending.destination, "version"), "utf8"),
      ).toBe("1.0.0");
      expect(
        await readFile(path.join(f.pending.staged, "version"), "utf8"),
      ).toBe("1.1.0");
      expect(JSON.parse(await readFile(f.resultPath, "utf8"))).toEqual({
        status: "failed",
        message: "launch_failed",
      });
    });

    it("aborts before swapping when the app does not exit", async () => {
      const f = await fixture();
      await expect(f.run("", process.pid)).rejects.toThrow();
      expect(
        await readFile(path.join(f.pending.destination, "version"), "utf8"),
      ).toBe("1.0.0");
      expect(JSON.parse(await readFile(f.resultPath, "utf8"))).toEqual({
        status: "failed",
        message: "app_exit_timeout",
      });
    });

    it("fails closed when process discovery fails", async () => {
      const f = await fixture();
      await expect(f.run("ps() { return 1; }")).rejects.toThrow();
      expect(JSON.parse(await readFile(f.resultPath, "utf8"))).toEqual({
        status: "failed",
        message: "process_scan_failed",
      });
      expect(
        await readFile(path.join(f.pending.destination, "version"), "utf8"),
      ).toBe("1.0.0");
    });

    it("aborts before swapping while a bundle process remains", async () => {
      const f = await fixture();
      await expect(
        f.run('ps() { printf "%s\\n" "$DEST/Contents/MacOS/helper"; }'),
      ).rejects.toThrow();
      expect(JSON.parse(await readFile(f.resultPath, "utf8"))).toEqual({
        status: "failed",
        message: "bundle_process_timeout",
      });
      expect(
        await readFile(path.join(f.pending.destination, "version"), "utf8"),
      ).toBe("1.0.0");
    });
  },
);

it("quotes single quotes and shell metacharacters as literal arguments", async () => {
  const value = "a' b;$(printf BAD)\\test";
  expect(
    (await execute("/bin/sh", ["-c", `printf '%s' ${shellQuote(value)}`]))
      .stdout,
  ).toBe(value);
});
