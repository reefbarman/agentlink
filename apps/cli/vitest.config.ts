import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __AGENTLINK_CLI_VERSION__: JSON.stringify("0.1.0-test"),
    __AGENTLINK_CLI_PACKAGED__: "false",
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    passWithNoTests: true,
    // An empty home directory per test file: see the file for why.
    setupFiles: [
      "../../src/testing/isolatedHome.ts",
      "../../src/testing/skipFsync.ts",
    ],
  },
});
