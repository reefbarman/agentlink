import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../../../src/shared/desktopBridge.js";
import type { ReleaseUpdateCandidate } from "../../../src/updates/releaseUpdateTypes.js";
import {
  checkDesktopUpdatePreconditions,
  DesktopReleaseInstaller,
  drainDesktopUpdateHelper,
  verifyDesktopUpdateBundle,
  type DesktopReleaseInstallOptions,
  type DesktopUpdateCommand,
} from "./desktopReleaseInstall.js";
import { registerDesktopReleaseInstallIpc } from "./desktopReleaseInstallIpc.js";
import type { DesktopPendingUpdate } from "./desktopUpdateApply.js";

const electron = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: { ...electron, send: vi.fn() },
}));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

async function bundle(
  directory: string,
  version = "1.0.0",
  identifier = "com.agentlink.desktop",
) {
  await mkdir(path.join(directory, "Contents/MacOS"), { recursive: true });
  await writeFile(
    path.join(directory, "Contents/MacOS/AgentLink"),
    "fake executable",
  );
  await writeFile(
    path.join(directory, "Contents/Info.plist"),
    JSON.stringify({
      CFBundleShortVersionString: version,
      CFBundleIdentifier: identifier,
    }),
  );
}

async function fixture(overrides: Partial<DesktopReleaseInstallOptions> = {}) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "desktop-release-install-"),
  );
  roots.push(root);
  const destination = path.join(root, "AgentLink.app");
  await bundle(destination);
  const userData = path.join(root, "data");
  const candidate: ReleaseUpdateCandidate = {
    version: "1.1.0",
    tag: "desktop-v1.1.0",
    target: `darwin-${process.arch}`,
    channel: "preview",
    releaseUrl: "https://example.com",
    instructionsUrl: "https://example.com/instructions",
  };
  const run = vi.fn<DesktopUpdateCommand>(async (file, args) => {
    if (file.endsWith("codesign")) return "TeamIdentifier=not set";
    if (file.endsWith("lipo")) return "arm64 x86_64";
    if (file.endsWith("PlistBuddy")) {
      const plist = JSON.parse(await readFile(args[2], "utf8"));
      return plist[args[1].slice("Print :".length)];
    }
    if (file.endsWith("ditto")) {
      await bundle(args[1], "1.1.0");
      return "";
    }
    if (file.endsWith("hdiutil")) return "";
    throw new Error(`Unexpected command ${file}`);
  });
  const options: DesktopReleaseInstallOptions = {
    packaged: true,
    executable: path.join(destination, "Contents/MacOS/AgentLink"),
    userData,
    identity: {
      product: "desktop",
      version: "1.0.0",
      target: candidate.target,
      development: false,
    },
    getCandidate: vi.fn(async () => candidate),
    confirmInstall: vi.fn(async () => true),
    confirmRestart: vi.fn(async () => false),
    drainHelper: vi.fn(async () => undefined),
    quit: vi.fn(),
    onState: vi.fn(),
    log: vi.fn(),
    run,
    download: vi.fn(async (_identity, _candidate, downloadOptions) => {
      await mkdir(downloadOptions.directory, { recursive: true });
      const dmg = path.join(downloadOptions.directory, "AgentLink.dmg");
      await writeFile(dmg, "verified fake DMG");
      downloadOptions.onState?.({
        phase: "downloading",
        received: 5,
        total: 5,
      });
      return dmg;
    }),
    launchApply: vi.fn(async () => undefined),
    ...overrides,
  };
  const installer = new DesktopReleaseInstaller(options);
  const pendingPath = path.join(userData, "updates/pending-update.json");
  const pending = async (): Promise<DesktopPendingUpdate> =>
    JSON.parse(await readFile(pendingPath, "utf8"));
  return {
    root,
    destination,
    userData,
    options,
    run,
    installer,
    pending,
    pendingPath,
  };
}

it.each([
  {
    packaged: false,
    executable: "/Applications/AgentLink.app/Contents/MacOS/AgentLink",
    message: /Source builds/,
  },
  {
    packaged: true,
    executable: "/Volumes/AgentLink/AgentLink.app/Contents/MacOS/AgentLink",
    message: /Disk images/,
  },
  {
    packaged: true,
    executable:
      "/private/AppTranslocation/abc/AgentLink.app/Contents/MacOS/AgentLink",
    message: /translocated/,
  },
  { packaged: true, executable: "/tmp/electron", message: /layout/ },
])(
  "refuses unsupported Desktop installation: $executable",
  async ({ message, ...options }) => {
    await expect(
      checkDesktopUpdatePreconditions({
        ...options,
        platform: "darwin",
        writable: async () => undefined,
        run: async () => "",
      }),
    ).rejects.toThrow(message);
  },
);

it("requires writable app and parent without elevation", async () => {
  const writable = vi.fn(async () => {
    throw new Error("EACCES");
  });
  await expect(
    checkDesktopUpdatePreconditions({
      packaged: true,
      executable: "/Applications/AgentLink.app/Contents/MacOS/AgentLink",
      platform: "darwin",
      writable,
    }),
  ).rejects.toThrow(/writable/);
});

it("refuses Team ID signatures even when codesign reports an invalid seal", async () => {
  for (const run of [
    async () => "TeamIdentifier=TEAM123",
    async () => {
      throw Object.assign(new Error("seal"), {
        stderr: "invalid signature\nTeamIdentifier=TEAM123",
      });
    },
  ]) {
    await expect(
      checkDesktopUpdatePreconditions({
        packaged: true,
        executable: "/Applications/AgentLink.app/Contents/MacOS/AgentLink",
        platform: "darwin",
        writable: async () => undefined,
        run,
      }),
    ).rejects.toThrow(/Team ID/);
  }
});

it.each(["code object is not signed at all", "invalid signature"])(
  "allows unsigned preview codesign diagnostics: %s",
  async (stderr) => {
    await expect(
      checkDesktopUpdatePreconditions({
        packaged: true,
        executable: "/Applications/AgentLink.app/Contents/MacOS/AgentLink",
        platform: "darwin",
        writable: async () => undefined,
        run: async () => {
          throw Object.assign(new Error(stderr), { stderr });
        },
      }),
    ).resolves.toBe("/Applications/AgentLink.app");
  },
);

it("does not treat a codesign execution failure as proof of an unsigned app", async () => {
  await expect(
    checkDesktopUpdatePreconditions({
      packaged: true,
      executable: "/Applications/AgentLink.app/Contents/MacOS/AgentLink",
      platform: "darwin",
      writable: async () => undefined,
      run: async () => {
        throw new Error("spawn EACCES");
      },
    }),
  ).rejects.toThrow(/EACCES/);
});

it("drains only the helper running from the Desktop executable", async () => {
  const shutdown = vi.fn(async () => undefined);
  const executable = "/Applications/AgentLink.app/Contents/MacOS/AgentLink";
  await expect(
    drainDesktopUpdateHelper({
      executable,
      helperPid: 42,
      shutdown,
      run: async () =>
        "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    }),
  ).rejects.toThrow(/not owned/);
  expect(shutdown).not.toHaveBeenCalled();
  await drainDesktopUpdateHelper({
    executable,
    helperPid: 42,
    shutdown,
    run: async () => executable,
  });
  expect(shutdown).toHaveBeenCalledOnce();
});

it("allows a restart retry after the already-drained helper has exited", async () => {
  const shutdown = vi.fn(async () => undefined);
  await drainDesktopUpdateHelper({
    executable: "/Applications/AgentLink.app/Contents/MacOS/AgentLink",
    helperPid: 42,
    shutdown,
    run: async () => {
      throw Object.assign(new Error("ps: missing pid"), {
        code: 1,
        stdout: "",
        stderr: "",
      });
    },
  });
  expect(shutdown).not.toHaveBeenCalled();
});

describe.skipIf(process.platform !== "darwin")("Desktop release host", () => {
  it("does not download without install consent", async () => {
    const f = await fixture({ confirmInstall: async () => false });
    expect((await f.installer.install()).phase).toBe("idle");
    expect(f.options.download).not.toHaveBeenCalled();
  });

  it("only stages after verified download, persists Later, and leaves destination untouched", async () => {
    const f = await fixture();
    expect((await f.installer.install()).phase).toBe("ready_to_restart");
    const pending = await f.pending();
    expect(path.dirname(path.dirname(pending.staged))).toBe(f.root);
    expect(
      await readFile(path.join(f.destination, "Contents/Info.plist"), "utf8"),
    ).toContain("1.0.0");
    expect(f.options.confirmRestart).toHaveBeenCalledWith("1.1.0");
    expect(f.options.drainHelper).not.toHaveBeenCalled();
    expect(f.options.quit).not.toHaveBeenCalled();
    await expect(
      readFile(path.join(f.userData, "updates/downloads/AgentLink.dmg")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const reopened = new DesktopReleaseInstaller(f.options);
    await reopened.reconcile();
    expect(reopened.snapshot().phase).toBe("ready_to_restart");
  });

  it("does not mount an unverified download", async () => {
    const f = await fixture({
      download: async () => {
        throw new Error("checksum mismatch");
      },
    });
    expect(await f.installer.install()).toMatchObject({
      phase: "failed",
      message: "checksum mismatch",
    });
    expect(f.run.mock.calls.some(([file]) => file.endsWith("hdiutil"))).toBe(
      false,
    );
  });

  it("retries busy detach and keeps a successfully staged update", async () => {
    const f = await fixture();
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (file, args) => {
      if (
        file.endsWith("hdiutil") &&
        args[0] === "detach" &&
        args[1] !== "-force"
      )
        throw new Error("Resource busy");
      return original(file, args);
    });
    expect((await f.installer.install()).phase).toBe("ready_to_restart");
    expect(f.run).toHaveBeenCalledWith("/usr/bin/hdiutil", [
      "detach",
      "-force",
      expect.any(String),
    ]);
  });

  it("keeps the primary staging error when detach also fails", async () => {
    const f = await fixture();
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (file, args) => {
      if (file.endsWith("hdiutil"))
        throw new Error(
          args[0] === "attach" ? "mount failed" : "detach failed",
        );
      return original(file, args);
    });
    expect(await f.installer.install()).toMatchObject({
      phase: "failed",
      message: "mount failed",
    });
    expect(
      (await readdir(f.root)).some((name) =>
        name.startsWith(".agentlink-update-"),
      ),
    ).toBe(true);
  });

  it("always detaches after staging fails", async () => {
    const f = await fixture();
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (file, args) => {
      if (file.endsWith("ditto")) throw new Error("copy failed");
      return original(file, args);
    });
    expect((await f.installer.install()).phase).toBe("failed");
    expect(
      (await readdir(f.root)).some((name) =>
        name.startsWith(".agentlink-update-"),
      ),
    ).toBe(false);
    expect(f.run).toHaveBeenCalledWith("/usr/bin/hdiutil", [
      "detach",
      expect.any(String),
    ]);
    await expect(readFile(f.pendingPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["identifier", "version", "architecture", "signature"])(
    "rejects incompatible staged %s",
    async (failure) => {
      const f = await fixture();
      const original = f.run.getMockImplementation()!;
      f.run.mockImplementation(async (file, args) => {
        if (args.some((value) => value.includes(".agentlink-update-"))) {
          if (
            failure === "identifier" &&
            args[1] === "Print :CFBundleIdentifier"
          )
            return "com.other.app";
          if (
            failure === "version" &&
            args[1] === "Print :CFBundleShortVersionString"
          )
            return "9.0.0";
          if (failure === "architecture" && file.endsWith("lipo"))
            return "unsupported";
          if (failure === "signature" && file.endsWith("codesign"))
            return "TeamIdentifier=TEAM123";
        }
        return original(file, args);
      });
      expect((await f.installer.install()).phase).toBe("failed");
      await expect(readFile(f.pendingPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(f.options.quit).not.toHaveBeenCalled();
    },
  );

  it("rejects a symlinked staged executable", async () => {
    const f = await fixture();
    const executable = path.join(f.destination, "Contents/MacOS/AgentLink");
    await rm(executable);
    await symlink("/bin/sh", executable);
    await expect(
      verifyDesktopUpdateBundle(f.destination, "1.0.0", process.arch, f.run),
    ).rejects.toThrow(/regular file/);
  });

  it("rechecks the destination fingerprint and staged bundle before draining", async () => {
    const f = await fixture();
    await f.installer.install();
    await bundle(f.destination, "9.0.0");
    f.options.confirmRestart = async () => true;
    expect((await f.installer.restart()).phase).toBe("failed");
    expect(f.options.drainHelper).not.toHaveBeenCalled();
    expect(f.options.launchApply).not.toHaveBeenCalled();
    expect(await f.pending()).toBeDefined();
  });

  it("drains the helper before detached launch and normal quit", async () => {
    const sequence: string[] = [];
    const f = await fixture({
      drainHelper: async () => {
        sequence.push("drain");
      },
      launchApply: async (script) => {
        sequence.push("launch");
        expect(await readFile(script, "utf8")).toContain(
          "backup_rename_failed",
        );
      },
      quit: () => {
        sequence.push("quit");
      },
    });
    await f.installer.install();
    f.options.confirmRestart = async () => true;
    await f.installer.restart();
    await f.installer.restart();
    await f.installer.install();
    expect(sequence).toEqual(["drain", "launch", "quit"]);
  });

  it.each(["helper", "spawn"])(
    "keeps staging restartable after a transient %s failure",
    async (failure) => {
      const f = await fixture();
      await f.installer.install();
      f.options.confirmRestart = async () => true;
      if (failure === "helper")
        f.options.drainHelper = async () => {
          throw new Error("shutdown temporarily unavailable");
        };
      else
        f.options.launchApply = async () => {
          throw new Error("spawn temporarily unavailable");
        };
      expect(await f.installer.restart()).toMatchObject({
        phase: "ready_to_restart",
        message: expect.stringContaining("Retry Restart to update"),
      });
      expect(f.options.quit).not.toHaveBeenCalled();
      expect(await f.pending()).toBeDefined();
      f.options.drainHelper = async () => undefined;
      f.options.launchApply = async () => undefined;
      await f.installer.restart();
      expect(f.options.quit).toHaveBeenCalledOnce();
    },
  );

  it("fails closed on staged signature tampering before restart", async () => {
    const f = await fixture();
    await f.installer.install();
    f.options.confirmRestart = async () => true;
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (file, args) =>
      file.endsWith("codesign") && args[1].includes(".agentlink-update-")
        ? "TeamIdentifier=TEAM123"
        : original(file, args),
    );
    expect((await f.installer.restart()).phase).toBe("failed");
    expect(f.options.drainHelper).not.toHaveBeenCalled();
    expect(f.options.quit).not.toHaveBeenCalled();
  });

  it("only cleans up after successful startup of the pending version", async () => {
    const f = await fixture();
    await f.installer.install();
    const pending = await f.pending();
    await rename(f.destination, pending.backup);
    await rename(pending.staged, f.destination);
    const restarted = new DesktopReleaseInstaller({
      ...f.options,
      identity: { ...f.options.identity, version: "1.1.0" },
    });
    await restarted.reconcile();
    expect(restarted.snapshot()).toMatchObject({
      phase: "installed",
      version: "1.1.0",
    });
    await expect(readFile(f.pendingPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(path.join(pending.backup, "Contents/Info.plist")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains backup and staging and surfaces recorded apply failures", async () => {
    const f = await fixture();
    await f.installer.install();
    const pending = await f.pending();
    await bundle(pending.backup);
    await writeFile(
      path.join(f.userData, "updates/apply-result.json"),
      JSON.stringify({ status: "failed", message: "activation_rename_failed" }),
    );
    const restarted = new DesktopReleaseInstaller(f.options);
    await restarted.reconcile();
    expect(restarted.snapshot()).toMatchObject({
      phase: "failed",
      message: expect.stringContaining(pending.backup),
    });
    expect(
      await readFile(path.join(pending.backup, "Contents/Info.plist"), "utf8"),
    ).toContain("1.0.0");
    expect(
      await readFile(path.join(pending.staged, "Contents/Info.plist"), "utf8"),
    ).toContain("1.1.0");
    expect((await restarted.install()).phase).toBe("failed");
  });

  it("archives a clean rollback without permanently blocking fresh installs", async () => {
    const f = await fixture();
    await f.installer.install();
    const pending = await f.pending();
    await writeFile(
      path.join(f.userData, "updates/apply-result.json"),
      JSON.stringify({ status: "failed", message: "bundle_process_timeout" }),
    );
    const reopened = new DesktopReleaseInstaller(f.options);
    await reopened.reconcile();
    expect(reopened.snapshot()).toMatchObject({
      phase: "failed",
      message: expect.stringContaining("fresh update"),
    });
    await expect(readFile(f.pendingPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await readFile(
        path.join(path.dirname(pending.staged), "pending-update.json"),
        "utf8",
      ),
    ).toContain(pending.version);
    expect(
      await readFile(path.join(pending.staged, "Contents/Info.plist"), "utf8"),
    ).toContain("1.1.0");
    expect((await reopened.install()).phase).toBe("ready_to_restart");
    expect(f.options.download).toHaveBeenCalledTimes(2);
  });

  it("retires stale pending updates after a newer manual installation", async () => {
    const f = await fixture();
    await f.installer.install();
    const pending = await f.pending();
    await bundle(f.destination, "2.0.0");
    const reopened = new DesktopReleaseInstaller({
      ...f.options,
      identity: { ...f.options.identity, version: "2.0.0" },
    });
    await reopened.reconcile();
    expect(reopened.snapshot()).toMatchObject({
      phase: "failed",
      message: expect.stringContaining("no longer newer"),
    });
    await expect(readFile(f.pendingPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await readFile(path.join(pending.staged, "Contents/Info.plist"), "utf8"),
    ).toContain("1.1.0");
    await reopened.restart();
    expect(f.options.launchApply).not.toHaveBeenCalled();
  });

  it("will not clean paths or overwrite a malformed pending record", async () => {
    const f = await fixture();
    await mkdir(path.dirname(f.pendingPath), { recursive: true });
    await writeFile(
      f.pendingPath,
      JSON.stringify({
        version: "1.1.0",
        staged: f.root,
        destination: f.destination,
        backup: f.root,
      }),
    );
    await f.installer.reconcile();
    expect(f.installer.snapshot().phase).toBe("failed");
    expect((await f.installer.install()).phase).toBe("failed");
    expect(f.options.download).not.toHaveBeenCalled();
    expect(await readFile(f.pendingPath, "utf8")).toContain(f.root);
  });

  it("composes chat preload IPC through native sender checks to install/restart callbacks", async () => {
    const f = await fixture();
    const event = { sender: { id: 42 } } as IpcMainInvokeEvent;
    const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>();
    const assertSender = vi.fn((received: IpcMainInvokeEvent) => {
      if (received.sender.id !== 42)
        throw new Error("unauthorized_desktop_ipc_sender");
    });
    let ready = false;
    registerDesktopReleaseInstallIpc({
      ipc: {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
      },
      assertSender,
      getInstaller: () => f.installer,
      isReady: () => ready,
    });
    electron.invoke.mockImplementation(async (channel) =>
      handlers.get(channel)!(event),
    );
    vi.stubGlobal("process", { ...process, isMainFrame: true });
    await import("./chatPreload.js");
    const bridge = electron.expose.mock.calls[0][1] as DesktopBridge;
    expect(await bridge.getReleaseInstallState!()).toEqual({ phase: "idle" });
    await expect(bridge.installReleaseUpdate!()).rejects.toThrow(
      "release_update_starting",
    );
    expect(f.options.download).not.toHaveBeenCalled();
    ready = true;
    const stateListener = vi.fn();
    const unsubscribe = bridge.onReleaseInstallState!(stateListener);
    f.options.onState = (state) =>
      electron.on.mock.calls.find(
        ([channel]) => channel === "agentlink:release-update:install-state",
      )?.[1]({ privateEvent: true }, state);
    expect((await bridge.installReleaseUpdate!()).phase).toBe(
      "ready_to_restart",
    );
    expect(await bridge.getReleaseInstallState!()).toMatchObject({
      phase: "ready_to_restart",
    });
    expect(stateListener).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "downloading", received: 5 }),
    );
    f.options.confirmRestart = async () => true;
    await bridge.restartForReleaseUpdate!();
    expect(f.options.drainHelper).toHaveBeenCalledOnce();
    expect(f.options.quit).toHaveBeenCalledOnce();
    expect(assertSender).toHaveBeenCalledWith(event);
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith(
      "agentlink:release-update:install-state",
      expect.any(Function),
    );
    for (const handler of handlers.values())
      expect(() =>
        handler({ sender: { id: 7 } } as IpcMainInvokeEvent),
      ).toThrow(/unauthorized/);
  });
});
