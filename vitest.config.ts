import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Use 'forks' pool so worker child processes exit cleanly after all tests
    // complete. The default 'vmThreads' pool keeps threads alive and causes
    // Vitest to hang indefinitely when tests leave no open handles themselves
    // but the thread pool supervisor never shuts down.
    pool: "forks",
    // Prisma's SQLite connection blocks Node exit — teardown handles cleanup.
    globalSetup: ["./src/test/global-setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // The perf harness runs ON DEMAND via `npm run perf` (serial, budget
    // checks) — keep it out of the default suite so CI stays fast and the
    // tight timings don't flake under parallel load.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next-build/**",
      "**/.next/**",
      "**/src-tauri/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite}.config.*",
      "tests/perf/**",
      "**/tests/perf/**",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
