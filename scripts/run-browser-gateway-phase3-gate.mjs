import { mkdtemp, rm } from "node:fs/promises";

import { join } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const suites = [
  "src/browser-gateway/testing/phase3ShadowParityGate.test.ts",
  "src/browser-gateway/testing/phase3LiveParityGate.test.ts",
  "src/browser-gateway/testing/phase3ReliabilityGate.test.ts",
  "src/browser-gateway/testing/phase3PerformanceGate.test.ts",
  "src/browser-gateway/testing/phase3MobileBrowserFixture.test.ts",
  "src/browser-gateway/testing/phase3MobilePaintGate.test.ts",
  "src/browser-gateway/testing/stateEquivalenceOracle.test.ts",
  "src/browser-gateway/testing/GatewayGenerationFaultHarness.test.ts",
  "src/browser-gateway/testing/SseFaultPeer.test.ts",
  "src/browser-gateway/browserGatewayDataPlaneMode.test.ts",
  "src/browser-gateway/migration/actionSurfaceInventory.test.ts",
  "src/browser-gateway/webview/relay/relayClientSelection.test.ts",
  "src/browser-gateway/webview/relay/RelayConnectionManager.test.ts",
  "src/browser-gateway/webview/relay/RelayOwnerStore.test.ts",
  "src/browser-gateway/webview/relay/relaySnapshotProjection.test.ts",
  "src/browser-gateway/dataPlane/OwnerTransport.test.ts",
  "src/browser-gateway/helper/RelaySseClientQueue.test.ts",
  "src/browser-gateway/helper/browserGatewayGenerationFaults.test.ts",
  "src/browser-gateway/helper/browserGatewayHelper.lifecycle.integration.test.ts",
  "src/browser-gateway/helper/browserGatewayRelay.integration.test.ts",
  "src/shared/streamingBaselineMetrics.test.ts",
  "src/shared/streamingBaselineFixture.test.ts",
  "src/agent/webview/components/TranscriptMessageList.test.ts",
  "src/browser-gateway/webview/BrowserGatewayApp.test.ts",
];

const arguments_ = process.argv.slice(2);
const sustained = arguments_.length === 1 && arguments_[0] === "--sustained";
if (arguments_.length > 0 && !sustained) {
  throw new Error(`Unknown Phase 3 gate argument: ${arguments_.join(" ")}`);
}

const isolatedHome = await mkdtemp(join(tmpdir(), "agentlink-phase3-gate-"));
try {
  const environment = { ...process.env, HOME: isolatedHome };
  if (sustained) environment.BROWSER_GATEWAY_RUN_LOAD_GATE = "1";
  else delete environment.BROWSER_GATEWAY_RUN_LOAD_GATE;
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
        reject(new Error(`browser gateway Phase 3 gate exited on ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
  process.exitCode = exitCode;
} finally {
  await rm(isolatedHome, { recursive: true, force: true });
}
