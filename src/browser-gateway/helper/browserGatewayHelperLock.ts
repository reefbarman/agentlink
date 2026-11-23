import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { randomUUID } from "node:crypto";
import { sleep } from "../../util/sleep.js";

/** Serialize helper selection and shutdown through publication of the next helper. */
export async function withBrowserGatewayHelperLock<T>(
  discoveryPath: string,
  log: (message: string) => void,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${discoveryPath}.startup.lock`;
  const owner = `${process.pid}-${randomUUID()}`;
  const candidatePath = `${lockPath}.${owner}`;
  const deadline = Date.now() + 40_000;
  let loggedContention = false;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.mkdir(candidatePath, { mode: 0o700 });
  try {
    await fs.writeFile(path.join(candidatePath, owner), "", { mode: 0o600 });
    while (true) {
      try {
        // Publish a nonempty directory in one operation. Rename cannot replace
        // another owner's nonempty directory, and a crash leaves no ownerless lock.
        await fs.rename(candidatePath, lockPath);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const windowsContention =
          process.platform === "win32" &&
          (code === "EPERM" || code === "EACCES") &&
          (await fs.stat(lockPath).then(
            (entry) => entry.isDirectory(),
            () => false,
          ));
        if (code !== "EEXIST" && code !== "ENOTEMPTY" && !windowsContention)
          throw error;
        if (!loggedContention) {
          log(
            "[browser-gateway-helper] waiting for another window's gateway startup or restart",
          );
          loggedContention = true;
        }
        await reclaimDeadOwner(lockPath, owner);
        if (Date.now() >= deadline)
          throw new Error("helper_startup_lock_timeout");
        await sleep(50);
      }
    }
    try {
      return await operation();
    } finally {
      // Vacate the lock atomically; cleanup can only touch our own directory.
      await fs.rename(lockPath, candidatePath);
    }
  } finally {
    await fs.rm(candidatePath, { recursive: true, force: true });
  }
}

async function reclaimDeadOwner(
  lockPath: string,
  owner: string,
): Promise<void> {
  try {
    const owners = await fs.readdir(lockPath);
    if (owners.length !== 1) return;
    const match = /^(\d+)-[a-f0-9-]+$/.exec(owners[0]);
    if (!match || Number(match[1]) <= 0) return;
    const directory = await fs.stat(lockPath);
    // Reclaiming changes the directory mtime when the old marker is renamed.
    // A pre-boot lock cannot belong to a live owner, even if its PID was reused.
    const beforeBoot =
      directory.mtimeMs + 60_000 < Date.now() - os.uptime() * 1_000;
    if (!beforeBoot) {
      try {
        process.kill(Number(match[1]), 0);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
      }
    }
    // Claim the old owner's unique marker before moving the directory away.
    // Other contenders then see this process as the owner, not the dead one.
    await fs.rename(path.join(lockPath, owners[0]), path.join(lockPath, owner));
    const retiredPath = `${lockPath}.retired-${owner}`;
    await fs.rename(lockPath, retiredPath);
    await fs.rm(retiredPath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
