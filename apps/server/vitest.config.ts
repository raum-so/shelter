import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Hosted runners can report more CPUs than their memory budget supports.
    maxWorkers: process.env.CI ? 2 : undefined,
  },
});
