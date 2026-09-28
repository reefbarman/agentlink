import * as path from "node:path";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PATH_MARKER = "__AGENTLINK_DESKTOP_SHELL_PATH__";

/** GUI-launched apps do not inherit the PATH set up by the user's shell. */
export async function resolveDesktopMcpPath(
  environment: NodeJS.ProcessEnv = process.env,
  runShell: (
    file: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string }> = execFileAsync,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (platform !== "darwin") return environment.PATH;
  const shell = environment.SHELL;
  const executable = shell && path.isAbsolute(shell) ? shell : "/bin/zsh";
  try {
    const { stdout } = await runShell(
      executable,
      ["-lic", `printf '\\n${PATH_MARKER}%s\\n' "$PATH"`],
      { env: environment, timeout: 3_000, maxBuffer: 64 * 1024 },
    );
    const marker = stdout.lastIndexOf(PATH_MARKER);
    const shellPath =
      marker >= 0
        ? stdout.slice(marker + PATH_MARKER.length).split("\n", 1)[0]
        : undefined;
    return shellPath && !shellPath.includes("\0")
      ? shellPath
      : environment.PATH;
  } catch {
    return environment.PATH;
  }
}
