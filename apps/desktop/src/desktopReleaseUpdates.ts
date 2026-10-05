import * as path from "node:path";

import {
  readDesktopPreferences,
  updateDesktopPreferences,
} from "./desktopPreferences.js";

import { ReleaseUpdateService } from "../../../src/updates/ReleaseUpdateService.js";

interface DesktopUpdateApp {
  getVersion(): string;
  isPackaged: boolean;
  getPath(name: "userData"): string;
}

export async function createDesktopReleaseUpdateService(
  app: DesktopUpdateApp,
  preferencesPath: string,
): Promise<ReleaseUpdateService> {
  const preferences = await readDesktopPreferences(preferencesPath);
  return new ReleaseUpdateService({
    identity: {
      product: "desktop",
      version: app.getVersion(),
      target: `${process.platform}-${process.arch}`,
      development: !app.isPackaged,
    },
    storageDirectory: path.join(app.getPath("userData"), "updates"),
    automaticChecks: preferences.automaticUpdateChecks ?? app.isPackaged,
    saveAutomaticChecks: async (value) => {
      await updateDesktopPreferences(preferencesPath, {
        automaticUpdateChecks: value,
      });
    },
  });
}
