import { defineConfig } from "vitest/config";
import path from "path";

// Perf-harness config: same resolve/global setup as the default suite, but
// WITHOUT the tests/perf exclusion so `npm run perf` can target it directly.
// The suite runs serially (--no-file-parallelism, see the npm script) for
// stable budget timings.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    pool: "forks",
    globalSetup: ["./src/test/global-setup.ts"],
    // Only the real perf benches. Without an explicit include, Vitest's
    // default `**/*.{test,spec}.*` glob sweeps stale duplicate copies under
    // src-tauri/target/debug/_up_/** and the Gate-4 run times out (240s)
    // collecting thousands of dead files.
    include: ["tests/perf/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/src-tauri/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite}.config.*",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
