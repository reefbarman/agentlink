import * as path from "node:path";

import { mkdir, readFile, writeFile } from "node:fs/promises";

export interface DesktopPreferences {
  quickAskShortcut?: string | null;
  /** Records that the first-run login-item default was applied. */
  openAtLoginInitialized?: boolean;
  automaticUpdateChecks?: boolean;
}

export async function readDesktopPreferences(
  filePath: string,
): Promise<DesktopPreferences> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf-8"));
    return parsed && typeof parsed === "object"
      ? (parsed as DesktopPreferences)
      : {};
  } catch {
    return {};
  }
}

export async function updateDesktopPreferences(
  filePath: string,
  update: DesktopPreferences,
): Promise<void> {
  const current = await readDesktopPreferences(filePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ ...current, ...update }, null, 2)}\n`,
    "utf-8",
  );
}
