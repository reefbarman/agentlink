import type { IpcMain, IpcMainInvokeEvent } from "electron";

import type { DesktopReleaseInstaller } from "./desktopReleaseInstall.js";

/** Kept in the native host. The browser gateway intentionally has no install route. */
export function registerDesktopReleaseInstallIpc(options: {
  ipc: Pick<IpcMain, "handle">;
  assertSender(event: IpcMainInvokeEvent): void;
  getInstaller(): DesktopReleaseInstaller | null;
  isReady(): boolean;
}): void {
  const installer = (event: IpcMainInvokeEvent): DesktopReleaseInstaller => {
    options.assertSender(event);
    const value = options.getInstaller();
    if (!value) throw new Error("release_update_unavailable");
    return value;
  };
  options.ipc.handle("agentlink:release-update:install-state", (event) =>
    installer(event).snapshot(),
  );
  const readyInstaller = (
    event: IpcMainInvokeEvent,
  ): DesktopReleaseInstaller => {
    const value = installer(event);
    if (!options.isReady()) throw new Error("release_update_starting");
    return value;
  };
  options.ipc.handle("agentlink:release-update:install", (event) =>
    readyInstaller(event).install(),
  );
  options.ipc.handle("agentlink:release-update:restart", (event) =>
    readyInstaller(event).restart(),
  );
}
