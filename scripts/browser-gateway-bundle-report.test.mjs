import {
  createBrowserGatewayBundleReport,
  verifyBrowserGatewayBundlePackaging,
} from "./browser-gateway-bundle-report.mjs";

import assert from "node:assert/strict";
import path from "node:path";
import { resolveBrowserGatewayDevBuild } from "./browser-gateway-build-env.mjs";
import test from "node:test";

test("keeps explicit DEV_BUILD values authoritative over .env.local", () => {
  assert.equal(resolveBrowserGatewayDevBuild("true", "DEV_BUILD=false"), true);
  assert.equal(resolveBrowserGatewayDevBuild("false", "DEV_BUILD=true"), false);
  assert.equal(
    resolveBrowserGatewayDevBuild(undefined, "DEV_BUILD=true"),
    true,
  );
  assert.equal(resolveBrowserGatewayDevBuild(undefined, undefined), false);
});

test("summarizes deterministic browser gateway bundle composition", () => {
  const rootDir = path.join(path.sep, "workspace", "agentlink");
  const metafile = {
    inputs: {
      "src/browser-gateway/webview/index.tsx": { bytes: 100 },
      "node_modules/monaco-editor/editor.js": { bytes: 1_000 },
      "node_modules/mermaid/index.js": { bytes: 800 },
      "node_modules/@mermaid-js/parser/index.js": { bytes: 500 },
      "node_modules/vega-lite/index.js": { bytes: 600 },
      "node_modules/vega-scenegraph/index.js": { bytes: 300 },
      "src/shared/ui/McpManagerPanel.tsx": { bytes: 120 },
      "src/shared/small.ts": { bytes: 50 },
    },
    outputs: {
      [path.join(rootDir, "dist", "browser-gateway.js")]: {
        bytes: 150,
        entryPoint: "src/browser-gateway/webview/index.tsx",
        imports: [
          { path: "dist/shared.js", kind: "import-statement" },
          {
            path: "dist/browser-gateway-chunks/chart-ABC123.js",
            kind: "dynamic-import",
          },
          {
            path: "dist/browser-gateway-chunks/mcp-ABC123.js",
            kind: "dynamic-import",
          },
          { path: "dist/browser-gateway-monaco.js", kind: "dynamic-import" },
        ],
        inputs: {
          "src/browser-gateway/webview/index.tsx": { bytesInOutput: 80 },
          "src/shared/small.ts": { bytesInOutput: 20 },
        },
      },
      [path.join(rootDir, "dist", "browser-gateway.css")]: {
        bytes: 200,
        inputs: {
          "src/shared/small.ts": { bytesInOutput: 10 },
        },
      },
      [path.join(rootDir, "dist", "browser-gateway.js.map")]: {
        bytes: 5_000,
        inputs: {},
      },
      [path.join(rootDir, "dist", "browser-gateway-chunks", "chart-ABC123.js")]:
        {
          bytes: 500,
          inputs: {
            "node_modules/mermaid/index.js": { bytesInOutput: 300 },
            "node_modules/@mermaid-js/parser/index.js": { bytesInOutput: 150 },
            "node_modules/vega-lite/index.js": { bytesInOutput: 250 },
            "node_modules/vega-scenegraph/index.js": { bytesInOutput: 75 },
          },
        },
      [path.join(rootDir, "dist", "browser-gateway-chunks", "mcp-ABC123.js")]: {
        bytes: 90,
        inputs: {
          "src/shared/ui/McpManagerPanel.tsx": { bytesInOutput: 75 },
        },
      },
      [path.join(rootDir, "dist", "browser-gateway-monaco.js")]: {
        bytes: 700,
        entryPoint: "src/browser-gateway/webview/components/browserMonaco.ts",
        inputs: {
          "node_modules/monaco-editor/editor.js": { bytesInOutput: 700 },
        },
      },
      [path.join(rootDir, "dist", "browser-gateway-monaco.css")]: {
        bytes: 80,
        inputs: {},
      },
      [path.join(rootDir, "dist", "shared.js")]: {
        bytes: 100,
        inputs: {
          "src/shared/small.ts": { bytesInOutput: 10 },
        },
      },
    },
  };

  const report = createBrowserGatewayBundleReport(metafile, {
    rootDir,
    topInputLimit: 3,
  });
  expectReport(report);
  expectReport(JSON.parse(JSON.stringify(report)));
});

function expectReport(report) {
  assert.deepEqual(report, {
    schemaVersion: 2,
    entryPoint: "src/browser-gateway/webview/index.tsx",
    totalBytes: 1_820,
    initialScriptBytes: 250,
    lazyScriptBytes: 1_290,
    initialScriptOutputs: ["dist/browser-gateway.js", "dist/shared.js"],
    outputs: [
      {
        path: "dist/browser-gateway-chunks/chart-ABC123.js",
        bytes: 500,
        kind: "script",
        entryPoint: null,
      },
      {
        path: "dist/browser-gateway-chunks/mcp-ABC123.js",
        bytes: 90,
        kind: "script",
        entryPoint: null,
      },
      {
        path: "dist/browser-gateway-monaco.css",
        bytes: 80,
        kind: "style",
        entryPoint: null,
      },
      {
        path: "dist/browser-gateway-monaco.js",
        bytes: 700,
        kind: "script",
        entryPoint: "src/browser-gateway/webview/components/browserMonaco.ts",
      },
      {
        path: "dist/browser-gateway.css",
        bytes: 200,
        kind: "style",
        entryPoint: null,
      },
      {
        path: "dist/browser-gateway.js",
        bytes: 150,
        kind: "script",
        entryPoint: "src/browser-gateway/webview/index.tsx",
      },
      {
        path: "dist/shared.js",
        bytes: 100,
        kind: "script",
        entryPoint: null,
      },
    ],
    heavyFeatures: {
      mcpManagement: 75,
      mermaid: 450,
      monaco: 700,
      vega: 325,
    },
    initialHeavyFeatures: {
      mcpManagement: 0,
      mermaid: 0,
      monaco: 0,
      vega: 0,
    },
    topInputs: [
      {
        path: "node_modules/monaco-editor/editor.js",
        bytesInOutput: 700,
        sourceBytes: 1_000,
      },
      {
        path: "node_modules/mermaid/index.js",
        bytesInOutput: 300,
        sourceBytes: 800,
      },
      {
        path: "node_modules/vega-lite/index.js",
        bytesInOutput: 250,
        sourceBytes: 600,
      },
    ],
  });
}

const PACKAGE_ALLOWLIST = `
!dist/browser-gateway.js
!dist/browser-gateway.css
!dist/browser-gateway-monaco.js
!dist/browser-gateway-monaco.css
!dist/browser-gateway-chunks/
!dist/browser-gateway-chunks/*.js
`;

const PACKAGED_REPORT = {
  outputs: [
    { path: "dist/browser-gateway.js", kind: "script" },
    { path: "dist/browser-gateway.css", kind: "style" },
    { path: "dist/browser-gateway-monaco.js", kind: "script" },
    { path: "dist/browser-gateway-monaco.css", kind: "style" },
    {
      path: "dist/browser-gateway-chunks/renderer-ABC123.js",
      kind: "script",
    },
  ],
  initialHeavyFeatures: {
    mcpManagement: 0,
    mermaid: 0,
    monaco: 0,
    vega: 0,
  },
};

test("verifies browser gateway runtime assets are package allowlisted", () => {
  assert.doesNotThrow(() =>
    verifyBrowserGatewayBundlePackaging(PACKAGED_REPORT, PACKAGE_ALLOWLIST),
  );
});

test("rejects missing browser gateway package rules", () => {
  assert.throws(
    () =>
      verifyBrowserGatewayBundlePackaging(
        PACKAGED_REPORT,
        PACKAGE_ALLOWLIST.replace("!dist/browser-gateway-monaco.css\n", ""),
      ),
    /browser_gateway_package_allowlist_missing:dist\/browser-gateway-monaco\.css/,
  );
});

test("rejects unexpected lazy assets", () => {
  assert.throws(
    () =>
      verifyBrowserGatewayBundlePackaging(
        {
          ...PACKAGED_REPORT,
          outputs: [
            ...PACKAGED_REPORT.outputs,
            {
              path: "dist/browser-gateway-chunks/renderer-ABC123.css",
              kind: "style",
            },
          ],
        },
        PACKAGE_ALLOWLIST,
      ),
    /browser_gateway_unexpected_lazy_asset:dist\/browser-gateway-chunks\/renderer-ABC123\.css/,
  );
});

test("rejects heavy features in the initial browser graph", () => {
  assert.throws(
    () =>
      verifyBrowserGatewayBundlePackaging(
        {
          ...PACKAGED_REPORT,
          initialHeavyFeatures: {
            ...PACKAGED_REPORT.initialHeavyFeatures,
            mermaid: 42,
          },
        },
        PACKAGE_ALLOWLIST,
      ),
    /browser_gateway_initial_heavy_feature:mermaid:42/,
  );
});
