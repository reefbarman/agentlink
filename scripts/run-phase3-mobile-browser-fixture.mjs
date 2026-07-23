import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const argumentsByName = parseArguments(process.argv.slice(2));
const helperPort = parsePort(argumentsByName.get("helper-port"), "helper-port");
const metadataPort = parsePort(
  argumentsByName.get("metadata-port"),
  "metadata-port",
);
const extensionRootPath = resolve(
  argumentsByName.get("extension-root") ?? process.cwd(),
);
const requestedHomeRoot = argumentsByName.get("home-root");
const homeRootPath = requestedHomeRoot
  ? resolve(requestedHomeRoot)
  : await mkdtemp(join(tmpdir(), "agentlink-phase3-mobile-fixture-home-"));
const buildRoot = await mkdtemp(
  join(tmpdir(), "agentlink-phase3-mobile-fixture-build-"),
);
let fixture;
let stopping = false;

try {
  const bundlePath = join(buildRoot, "fixture.cjs");
  await build({
    entryPoints: [
      resolve(
        extensionRootPath,
        "src/browser-gateway/testing/phase3MobileBrowserFixture.ts",
      ),
    ],
    outfile: bundlePath,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    sourcemap: "inline",
    define: { __DEV_BUILD__: "true" },
    logLevel: "warning",
  });
  const fixtureModule = await import(
    `${pathToFileURL(bundlePath).href}?${Date.now()}`
  );
  fixture = new fixtureModule.Phase3MobileBrowserFixture({
    helperPort,
    metadataPort,
    homeRootPath,
    extensionRootPath,
    dataPlaneMode: "on",
  });
  await fixture.start();
  process.stdout.write(
    `${JSON.stringify({
      type: "phase3_mobile_fixture_ready",
      baseUrl: fixture.baseUrl,
      metadataBaseUrl: fixture.metadataBaseUrl,
      metadataAuthToken: fixture.metadataAuthToken,
      homeRootPath,
      identity: fixture.identity,
    })}\n`,
  );
} catch (error) {
  await cleanup();
  throw error;
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

await new Promise(() => {});

async function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  await cleanup();
  process.exit(exitCode);
}

async function cleanup() {
  await fixture?.stop().catch(() => undefined);
  await rm(buildRoot, { recursive: true, force: true });
  if (!requestedHomeRoot) {
    await rm(homeRootPath, { recursive: true, force: true });
  }
}

function parseArguments(arguments_) {
  const result = new Map();
  for (const argument of arguments_) {
    if (!argument.startsWith("--") || !argument.includes("=")) {
      throw new Error(`Invalid argument: ${argument}`);
    }
    const [name, ...value] = argument.slice(2).split("=");
    if (!name || value.length === 0)
      throw new Error(`Invalid argument: ${argument}`);
    result.set(name, value.join("="));
  }
  for (const name of result.keys()) {
    if (
      name !== "helper-port" &&
      name !== "metadata-port" &&
      name !== "home-root" &&
      name !== "extension-root"
    ) {
      throw new Error(`Unknown argument: --${name}`);
    }
  }
  return result;
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`--${name} must be an explicit nonzero TCP port`);
  }
  return port;
}
