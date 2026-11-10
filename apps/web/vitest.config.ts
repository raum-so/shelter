import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.js";

export default mergeConfig(viteConfig, defineConfig({
  test: {
    // Keep independent DOM workers within the hosted runner's memory budget.
    maxWorkers: process.env.CI ? 2 : undefined,
  },
}));
