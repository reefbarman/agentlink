import { mkdtemp, rm } from "node:fs/promises";

import { join } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const suites = [
  "src/browser-gateway/dataPlane/protocol.test.ts",
  "src/browser-gateway/dataPlane/ownerProjectionAdapter.test.ts",
  "src/browser-gateway/dataPlane/OwnerTransport.test.ts",
  "src/browser-gateway/helper/dataPlaneRoutes.test.ts",
  "src/browser-gateway/helper/dataPlaneRoutes.unit.test.ts",
  "src/browser-gateway/helper/HelperHttpRouter.test.ts",
  "src/browser-gateway/helper/OwnerRelayStore.test.ts",
  "src/browser-gateway/helper/RelaySseClientQueue.test.ts",
  "src/browser-gateway/helper/relayRoutes.test.ts",
  "src/browser-gateway/helper/commandRoutes.test.ts",
  "src/browser-gateway/helper/pairingBroker.test.ts",
  "src/browser-gateway/helper/browserGatewayRelay.integration.test.ts",
  "src/browser-gateway/browserGatewayRouteInventory.test.ts",
];

const isolatedHome = await mkdtemp(join(tmpdir(), "agentlink-phase0-gate-"));
try {
  const environment = { ...process.env, HOME: isolatedHome };
  delete environment.BROWSER_GATEWAY_RUN_LOAD_GATE;
  const child = spawn(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", ...suites],
    {
      stdio: "inherit",
      env: environment,
    },
  );
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`browser gateway security gate exited on ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
  process.exitCode = exitCode;
} finally {
  await rm(isolatedHome, { recursive: true, force: true });
}
