import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __AGENTLINK_CLI_VERSION__: JSON.stringify("0.1.0-test"),
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    passWithNoTests: true,
  },
});
