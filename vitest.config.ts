import { defineConfig } from "vitest/config";

export default defineConfig({
  // The web app's tsconfig keeps JSX for Next to compile; a test compiles it itself.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: [
      "apps/*/{src,test}/**/*.test.{ts,tsx}",
      "packages/*/{src,test}/**/*.test.ts",
      "guest/image-builder/{src,test}/**/*.test.ts",
      // Checks over the whole repository, such as the platform branches of section 1.1.
      "tests/repo/**/*.test.ts",
    ],
    // The web client's tests run here with everything else: the ones of plain functions in
    // node, the component tests (.test.tsx) in jsdom, chosen by the file's own
    // "@vitest-environment jsdom" line so that no other test pays for a DOM.
    // invisible_engine_dots/ holds the nanobot fork: Python, with its own pytest suite
    // (the engine job of the CI workflow); nothing of it runs here.
    // A `*.linux.test.ts` drives a Linux program of the guest itself (dot-agentd, with its bash and its unix
    // sockets): it is collected on Linux only, so on another host it is neither run nor counted as skipped.
    exclude: ["**/node_modules/**", "**/.next/**", "invisible_engine_dots/**", ...(process.platform === "linux" ? [] : ["**/*.linux.test.ts"])],
    environment: "node",
    // Setup hooks boot an embedded PostgreSQL (PGlite, WebAssembly) and run
    // the migrations, or start servers and child processes. On a loaded
    // machine that takes longer than vitest's default 10 s without anything
    // being wrong (measured: the API suite's setup timed out in a container
    // running the whole suite in parallel), so it gets one allowance here
    // instead of one per file.
    hookTimeout: 60_000,
    // The same for a test: one that starts servers or child processes can
    // stall for seconds under heavy disk contention without anything being
    // wrong. A test that waits on a condition fails on a code fault only,
    // never on the machine's speed.
    testTimeout: 30_000,
  },
});
