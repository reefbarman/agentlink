import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  define: {
    __DEV_BUILD__: "true",
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "src/__mocks__/vscode.ts"),
    },
  },
  test: {
    // Let jsdom provide browser storage instead of Node's file-backed Web Storage.
    execArgv: ["--no-experimental-webstorage"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Absolute so workspaces that inherit this config (apps/desktop) resolve it.
    setupFiles: [path.resolve(__dirname, "src/testing/vitestSetup.ts")],
  },
});
