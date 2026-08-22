import { defineConfig } from "vitest/config";

// A separate vitest project so `pnpm --filter web test` never requires a
// running chain. `globalSetup` automates the local-Anvil fork bring-up +
// A's Deploy.s.sol before collection (populating FACTORY_ADDRESS /
// ANVIL_RPC_URL); it no-ops (→ test skips) when Foundry is absent, when
// SKIP_ANVIL=1, or when the caller already provided FACTORY_ADDRESS.
export default defineConfig({
  test: {
    include: ["src/test/anvil/**/*.anvil.test.ts"],
    globalSetup: ["./src/test/anvil/globalSetup.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
