import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    // The single `beforeAll` does a lot of real, external work: bring up a
    // forked Anvil (network round-trips to the flaky public RPC), run A's
    // Deploy.s.sol + a launch + a swap + a transfer through it, then cold-build
    // and start Ponder and wait for it to sync the seeded history. 120s (the
    // brief's figure) is comfortable for the per-test HTTP assertions but too
    // tight for that hook on a cold cache, so hookTimeout is raised while
    // testTimeout stays at the brief's value.
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // These integration tests share one Anvil + one Ponder started in a single
    // file's beforeAll; never run their files in parallel against each other.
    fileParallelism: false,
  },
});
