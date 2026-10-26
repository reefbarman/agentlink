import baseConfig from "./vitest.config.mts";
import { defineConfig } from "vitest/config";

// Live model evals. Kept out of `npm test` because they call a real provider.
// Spread rather than mergeConfig, which would concatenate the include arrays.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ["src/evals/**/*.eval.ts"],
  },
});
