import { defineConfig } from "vitest/config";

const testPaths = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const selectsApi = testPaths.some((path) => /(?:^|\/)tests\/api(?:\/|$)/.test(path));
const selectsOnlyUnit = testPaths.some((path) => /(?:^|\/)tests\/unit(?:\/|$)/.test(path)) &&
  !selectsApi;

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Unit-only runs intentionally remain database-free. An API selection (or
    // an unfiltered all-tests run) owns the shared durable-cache fixture.
    globalSetup: selectsOnlyUnit ? [] : ["./tests/api/global-setup.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
