import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    // An empty home directory per test file: see the file for why.
    setupFiles: [
      "../../src/testing/isolatedHome.ts",
      "../../src/testing/skipFsync.ts",
    ],
  },
});
