// Gives each test file an empty, throwaway home directory, so no test can read
// or change the real ~/.agentlink (gateway registry, credentials, telemetry,
// MCP config) or pass only because of what is on the developer's machine.
// Listed in `setupFiles`, so it runs before the test file's imports capture any
// home-relative path. Child processes inherit it through `process.env`.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isMainThread } from "node:worker_threads";

// Changes to process.env in worker threads don't reliably affect native home
// lookups. Reject that pool before any test can load or write real user config.
if (!isMainThread) {
  throw new Error(
    "AgentLink test home isolation requires Vitest's forks pool. Remove --pool=threads or use --pool=forks.",
  );
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-test-home-"));

process.env.HOME = home;
process.env.USERPROFILE = home;
if (os.homedir() !== home) {
  fs.rmSync(home, { recursive: true, force: true });
  throw new Error(
    "AgentLink tests refused to run: temporary home isolation failed.",
  );
}
// Version-manager shims (mise, asdf, volta) look up their state under the home
// directory and fail without it. Put the Node running the tests first on PATH
// so a test that spawns `node` or `npm` gets that one directly.
process.env.PATH = [path.dirname(process.execPath), process.env.PATH]
  .filter(Boolean)
  .join(path.delimiter);

process.on("exit", () => {
  fs.rmSync(home, { recursive: true, force: true });
});
