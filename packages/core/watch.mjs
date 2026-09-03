import { context } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let declarations = Promise.resolve();

const declarationsPlugin = {
  name: "core-declarations",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      declarations = declarations
        .catch(() => undefined)
        .then(async () => {
          await execFileAsync("npx", ["tsc", "-p", "tsconfig.json"], {
            cwd: process.cwd(),
          });
          await execFileAsync("node", ["build-cjs.mjs", "--metadata-only"], {
            cwd: process.cwd(),
          });
        })
        .catch((error) => {
          console.error(error.stderr || error.message);
        });
    });
  },
};

const sharedCoreModuleNames = new Set([
  "agentEngine",
  "agentToolLoop",
  "codex",
  "embeddedAgentWeb",
  "hostAdapterContracts",
  "hostApprovalTestKit",
  "hostTools",
  "modelAuthProvider",
  "modelRequestScheduler",
  "modelRuntime",
  "nativeWebTools",
  "openAiCompatible",
  "providerStreamWatchdog",
  "sessionRepository",
  "sessionTranscriptRecall",
  "surfaceModelMessages",
  "toolCallBudget",
  "turnContracts",
  "turnExecution",
  "turnInteractions",
  "turnKernel",
  "turnLeases",
  "webAccess",
]);
const sharedCoreModulesPlugin = {
  name: "shared-core-modules",
  setup(build) {
    build.onResolve({ filter: /^\.\.?(?:\/.*)?\.js$/ }, (args) => {
      const module = args.path.split("/").at(-1)?.replace(/\.js$/, "");
      return module && sharedCoreModuleNames.has(module)
        ? { path: `./${module}.cjs`, external: true }
        : undefined;
    });
  },
};

const cjs = await context({
  entryPoints: [
    "src/agentEngine.ts",
    "src/agentToolLoop.ts",
    "src/codex.ts",
    "src/embeddedAgentWeb.ts",
    "src/hostAdapterContracts.ts",
    "src/hostApprovalTestKit.ts",
    "src/hostTools.ts",
    "src/modelAuthProvider.ts",
    "src/modelRequestScheduler.ts",
    "src/modelRuntime.ts",
    "src/nativeWebTools.ts",
    "src/openAiCompatible.ts",
    "src/providerStreamWatchdog.ts",
    "src/sessionRepository.ts",
    "src/sessionTranscriptRecall.ts",
    "src/surfaceModelMessages.ts",
    "src/toolCallBudget.ts",
    "src/turnContracts.ts",
    "src/turnExecution.ts",
    "src/turnInteractions.ts",
    "src/turnKernel.ts",
    "src/turnLeases.ts",
    "src/webAccess.ts",
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir: "dist/cjs",
  outExtension: { ".js": ".cjs" },
  sourcemap: true,
  plugins: [sharedCoreModulesPlugin, declarationsPlugin],
});

await cjs.watch();

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await cjs.dispose();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, stop);
}
